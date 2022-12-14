import {AllCoinsInformationResponse, MainClient, SpotOrder, WebsocketClient} from "binance";
import {
    WsFormattedMessage,
    WsMessageAggTradeFormatted,
} from "binance/lib/types/websockets";

import {isWsSpotUserDataExecutionReportFormatted, isWsAggTradeFormatted} from "./typeGuards";
import {Socket} from "socket.io";

const express = require("express");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);
app.use(express.static(__dirname));

const {OrderManager, Logger, CoinUtils, OrdersUtils} = require("./AppUtils");


const apikey = process.env.APIKEY || '';
const apisecret = process.env.APISECRET || '';
const appPort = process.env.APP_PORT || 5001

Logger.info(`Starting app with:`);
Logger.info(`apikey=${apikey}`);
Logger.info(`apisecret=${apisecret}`);
Logger.info(`appPort=${appPort}`);

const restClient = new MainClient({
  api_key: apikey,
  api_secret: apisecret,
});

const wsClient = new WebsocketClient(
  {
    api_key: apikey,
    api_secret: apisecret,
    beautify: true,
  }
);

const appData = require("./resources/appData.json");

const Deque = require("collections/deque");

let subscribedTickers: string[] = []
const upalerts = new Map();
const downalerts = new Map();

const bookCostmap = new Map();

const tickersToVolObjs = new Map();
const MAX_VOLUMES_QUEUE_SIZE = 30

const tradeCountsPerMinute: Map<string, number> = new Map();

const balanceObj = {
    accountUSDBalance: null,
    balancesMap: new Map()
};


initApp(socketio, wsClient, restClient);


http.listen(appPort, () => {
  Logger.info(`Open browser on http://localhost:${appPort}`);

});



function getAlertsForPrice(priceUpdate: any) {
    const uplevel = upalerts.get(priceUpdate.ticker);
    const downlevel = downalerts.get(priceUpdate.ticker);

    let alertObj = {ticker: '', direction: ''};
    if (uplevel != null && priceUpdate.priceObj.price > uplevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'up';
    } else if (downlevel != null && priceUpdate.priceObj.price < downlevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'down';
    } else if (uplevel != null || downlevel != null) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = ''; // means not triggered or untriggered (from up or down)
    }
    return alertObj;
}

async function buildAccountAndCoinBalances(rc: MainClient, accountBalances: AllCoinsInformationResponse[], coinsToUpdate: string[]) {

    let accountUSDBalance = 0;
    const coinsToAccountBalances = new Map();

    for (const coinBalance of accountBalances) {

        let coin = coinBalance.coin;

         try {
            const usdPrice = await getCoinUsdValue(rc, coin);
            const balanceValue = Number(coinBalance.free);
            const balanceUsdValue = usdPrice * balanceValue;
            coinsToAccountBalances.set(coin, {coin: coin, balance: balanceValue, usdValue: balanceUsdValue});
            accountUSDBalance = balanceUsdValue + accountUSDBalance;
        } catch (e) {
            Logger.warn("an error occurred while fetching the USD price of " + coin +
                ". The balance will not be updated", e);
        }
    }

    return {
        accountUSDBalance: accountUSDBalance,
        balancesMap: coinsToUpdate.map(t => [t, coinsToAccountBalances.get(CoinUtils.parseCoinFromTicker(t))])
    };

}

async function getCoinUsdValue(rc: MainClient, coin: string): Promise<number> {

    let usdValue;

    if(coin === 'BUSD'){
        usdValue = 1;
    } else {
        const usdTicker = coin+'BUSD';
        try {
            const resp: any = await rc.getSymbolPriceTicker({symbol: usdTicker});
            usdValue = resp.price;
        } catch(e){
            throw e;
        }
    }
    return usdValue;
}



function updateAppStateBalances(balancesJson: any) {
    balanceObj.accountUSDBalance = balancesJson.accountUSDBalance;
    balanceObj.balancesMap = balancesJson.balancesMap;
    return balanceObj;
}

function initApp(sio: Socket, ws: WebsocketClient, rc: MainClient) {

    Logger.info("initialising app");

    // we add BUSD as a "ticker". This will give us the cash balance on the account
    const coinsToUpdate: string[] = appData.tickerWatchlist.concat([appData.accountCcy]);

    Logger.info('updating account and coin balances');
    CoinUtils.getNonZeroBalances(rc)
        .then((balances: AllCoinsInformationResponse[]) => {
            buildAccountAndCoinBalances(rc, balances, coinsToUpdate).then(balancesJson => updateAppStateBalances(balancesJson));
        }).catch((e: any) => {
            let error = new Error("Unable to retrieve account balances for App initialisation"); // TODO implement own App error type
            error.stack = e.stack;
            throw  error;
        });


    // refresh account balances every 60 seconds
    setInterval(() => {
        CoinUtils.getNonZeroBalances(rc)
            .then((balances: AllCoinsInformationResponse[]) => { buildAccountAndCoinBalances(rc, balances, coinsToUpdate)
                .then(balancesJson => updateAppStateBalances(balancesJson))
                .then((balancesJson) => sio.emit('balances:update', balancesJson))});

        }, 60000);


    // initialise trade counts map
    appData.tickerWatchlist.forEach((t: string) => tradeCountsPerMinute.set(t, 0));

    // publish trade counts every 30 seconds then reset counts for the next 30s cycle
    setInterval(() => {
        sio.emit('tradeStats:update', tradeCountsPerMinute);
        appData.tickerWatchlist.forEach((t: string) => tradeCountsPerMinute.set(t, 0));
    }, 30000);


    ws.subscribeSpotUserDataStream();

    const om = new OrderManager(rc);
    sio.on('connection', (socket: Socket) => {

        Logger.info('received socket connection');
        sio.emit('balances:update', balanceObj);

        socket.on('prices:subscribe', function (ticker: string) {

            if(!subscribedTickers.includes(ticker)){
                try {
                    Logger.log("subscribing to real time price updates for ", ticker);
                    ws.subscribeSpotAggregateTrades(CoinUtils.convertToBinanceTicker(ticker));
                    subscribedTickers.push(ticker);
                    // TODO fix PnL call
                    //PnL.buildCoinCostMap(tickersNotSubscribedYet, bookCostmap, restClient);
                } catch (e) {
                    Logger.warn("couldn't subscribe to ticker ", ticker);
                }
            }

        });

        socket.on('orders:new-market-order', async (order: any) => {
            Logger.info('received market order', order);
            const marketOrder = OrdersUtils.convertToBinanceMarketOrder(order);
            try {
                let resp = await om.placeOrder(marketOrder);
                Logger.info('market order successfully placed', resp)
            } catch (e) {
                Logger.warn('market order failed', e)
            }
        });

        socket.on('orders:new-limitbook-order', async (order: any) => {

            Logger.info("received limit order", order);
            const limOrder = OrdersUtils.convertToBinanceLimitOrder(order);

            let res;
            try {
                const book = await rc.getOrderBook({symbol:limOrder.symbol});

                const orderSide = limOrder.side

                let limitPrice;
                if (orderSide === 'BUY') {
                    limitPrice = book.bids[2][0]; // this means the third best price on the order book
                } else if (orderSide === 'SELL') {
                    limitPrice = book.asks[2][0];
                } else {
                    throw new Error("Order must be a BUY or SELL. Received a " + orderSide);
                }

                limOrder.price = limitPrice;

                res = await om.placeOrder(limOrder);

                Logger.info("Limit order placed", res);

            } catch(e: any) {
                Logger.warn(`Order was not placed. Reason: ${e.message}`);
            }

        });

        socket.on('orders:cancel-orders', async (tkr: string) => {
            Logger.info("cancelling all pending orders for " + tkr);

            const ticker = CoinUtils.convertToBinanceTicker(tkr);


            try {
                let pendingOrders: SpotOrder[] = await om.getOpenOrders(ticker);

                if (pendingOrders.length === 0) {
                    Logger.log("no pending orders found for " + ticker);
                } else {
                    for (const order of pendingOrders) {
                        let resp = await rc.cancelOrder({symbol: order.symbol, orderId: order.orderId});
                        Logger.log("order cancelled", resp);
                    }
                }

            } catch (e) {
                Logger.warn("Orders did not cancel", e);
            }
        });


        socket.on('alerts:new-alert', (alertObj: any) => {
            const alertsMapToUpdate = alertObj.direction === 'up' ? upalerts : downalerts;
            Logger.log(`setting up ${alertObj.direction} alert for ${alertObj.ticker} @level ${alertObj.alertlevel}`);
            alertsMapToUpdate.set(alertObj.ticker, alertObj.alertlevel);
        });
        socket.on('alerts:cancel-alerts', (ticker: string) => {
            Logger.info(`cancelling all alerts for ${ticker}`);
            upalerts.delete(ticker);
            downalerts.delete(ticker);
        });


    });

    ws.on('formattedMessage', (data: WsFormattedMessage) => {

        if(isWsAggTradeFormatted(data)){
            processSpotAggregateTrades(data);
        } else if (isWsSpotUserDataExecutionReportFormatted(data)) {
            if (data.orderStatus === 'NEW') {
                Logger.info(`received a order confirmation for ${data.symbol}`);
            } else if (data.orderStatus === 'FILLED') {
                Logger.info("received a fill for: " + data.symbol);
                const fill = {
                    market: CoinUtils.convertFromBinanceTicker(data.symbol),
                    size: data.quantity,
                };
                sio.emit('orders:fill', fill);
            } else if (data.orderStatus === 'CANCELED') {
                Logger.info(`received a order cancellation confirmation of ${data.quantity} ${data.symbol}`);
            } else {
                Logger.info(`recevied a user execution event for ${data.symbol}`, data);
            }
        }

    });


    function processSpotAggregateTrades(trade: WsMessageAggTradeFormatted) {

        const price = trade.price;
        const qty = trade.quantity;

        const ticker = CoinUtils.convertFromBinanceTicker(trade.symbol);

        var priceObj = {
            "ticker": ticker,
            "price": price,
            "qty": qty,
            "cons": Math.round(price * qty)
        }

        //Logger.info(`received new trade: ticker:${trade.ticker} price:${trade.price} qty:${trade.qty} consideration:${trade.cons}`);

        const priceUpdate = handlePriceUpdate(priceObj);
        const alerts = getAlertsForPrice(priceUpdate);

        // update trade counts map
        let count = tradeCountsPerMinute.get(ticker);
        tradeCountsPerMinute.set(ticker, (count === undefined ? 0 : count) + 1);

        sio.emit('prices:update', [priceUpdate, alerts]);

    }



}

function handlePriceUpdate(priceObj: any) {

    const ticker = priceObj.ticker;
    const volumesObj = getVolumesObj(ticker);

    let newSumVol;
    if(volumesObj.queue.length < MAX_VOLUMES_QUEUE_SIZE){
        newSumVol = volumesObj.queue.reduce((r: any, v: any) => r + v, 0) + priceObj.cons;
        updateVolumesObj(volumesObj, priceObj.cons, newSumVol);

    } else {
        newSumVol = volumesObj.sum - volumesObj.queue.peek() + priceObj.cons;
        updateVolumesObj(volumesObj, priceObj.cons, newSumVol);
    }

    const sumVolumes = newSumVol;


    const bookCost = bookCostmap.get(ticker);

    return {
        ticker: ticker,
        priceObj: priceObj,
        tradeVolume: sumVolumes,
        tradesPerSecond: 0,
        bookCost: bookCost == null ? 0 : bookCost
    }

}


function getVolumesObj(ticker: string) {
    var volumesObj = tickersToVolObjs.get(ticker);
    if(volumesObj === undefined) {
        const volumeQ = new Deque();
        volumesObj = {queue: volumeQ, sum: null};
        tickersToVolObjs.set(ticker, volumesObj);
    }
    return volumesObj;
}

function updateVolumesObj(volumesObj: any, latestVolume: number, newVolSum: number) {
    volumesObj.queue.push(latestVolume);
    volumesObj.sum = newVolSum;
    if(volumesObj.queue.length > MAX_VOLUMES_QUEUE_SIZE) {
        volumesObj.queue.shift();
    }
}


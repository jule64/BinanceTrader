import {AllCoinsInformationResponse, MainClient, SpotOrder, WebsocketClient} from "binance";
import {
    WsFormattedMessage, WsMessage24hrMiniTickerFormatted,
    WsMessageAggTradeFormatted,
} from "binance/lib/types/websockets";

import {isWsSpotUserDataExecutionReportFormatted, isWsAggTradeFormatted, isWs24hrMiniTickerFormattedMessage} from "./typeGuards";
import {Socket} from "socket.io";

const express = require("express");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);
app.use(express.static(__dirname));

const {OrderManager, Logger, CoinUtils, OrderUtils} = require("./AppUtils");


const apikey = process.env.APIKEY;
if(!apikey) {
    throw new Error("no api key provided")
}

const apisecret = process.env.APISECRET;
if(!apisecret) {
    throw new Error("no api secret provided")
}
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
const coinsToAccountBalances = new Map(); // Map<coin,{coin: coin, balance: balanceValue, usdValue: balanceUsdValue}>

const Deque = require("collections/deque");

let subscribedTickers: string[] = []
const upalerts = new Map();
const downalerts = new Map();

const bookCostmap = new Map();

const tickersToVolObjs = new Map();
const MAX_VOLUMES_QUEUE_SIZE = 30

const tradeCountsPerMinute: Map<string, number> = new Map();
const mini24hrTickerStats: Map<string, object> = new Map();


initApp(socketio, wsClient, restClient);


http.listen(appPort, () => {
  Logger.info(`Open browser on http://localhost:${appPort}`);

});



function getAlertsForPrice(ticker: string, price: number) {
    const uplevel = upalerts.get(ticker);
    const downlevel = downalerts.get(ticker);

    let alertObj;


    if (uplevel != null && price > uplevel) {
        alertObj = {ticker: ticker, direction: 'up'};
    } else if (downlevel != null && price < downlevel) {
        alertObj = {ticker: ticker, direction: 'down'};
    } else if (uplevel != null || downlevel != null) {
        alertObj = {ticker: ticker, direction: ''}; // means not triggered (or untriggered from up or down)
    } else {
        alertObj = {};
    }
    return alertObj;
}

async function buildAccountAndCoinBalances(rc: MainClient, accountBalances: AllCoinsInformationResponse[], coinsToUpdate: string[]) {
    let accountUSDBalance = 0;
    for (const coinBalance of accountBalances) {
        let coin = coinBalance.coin;
         try {
            const usdPrice = await getCoinUsdValue(rc, coin);
            const balanceValue = Number(coinBalance.free);
            const balanceUsdValue = usdPrice * balanceValue;
            coinsToAccountBalances.set(coin, {coin: coin, balance: balanceValue, usdValue: balanceUsdValue});
            accountUSDBalance = accountUSDBalance + balanceUsdValue;
        } catch (e) {
            Logger.warn("an error occurred while fetching the USD price of " + coin +
                ". The balance will not be updated");
        }
    }
    coinsToAccountBalances.set('ACCOUNT_ALL_BAL', {coin: 'ACCOUNT_ALL_BAL', balance: 1, usdValue: accountUSDBalance});
}

async function getCoinUsdValue(rc: MainClient, coin: string): Promise<number> {

    let usdValue;

    if(coin === 'USDT'){
        usdValue = 1;
    } else {
        const usdTicker = coin+'USDT';
        try {
            const resp: any = await rc.getSymbolPriceTicker({symbol: usdTicker});
            usdValue = resp.price;
        } catch(e){
            throw e;
        }
    }
    return usdValue;
}


function initApp(sio: Socket, ws: WebsocketClient, rc: MainClient) {

    Logger.info("initialising app");

    // we add USDT as a "ticker". This will give us the cash balance on the account
    const coinsToUpdate: string[] = appData.tickerWatchlist.concat([appData.accountCcy]);

    Logger.info('updating account and coin balances');
    CoinUtils.getNonZeroBalances(rc)
        .then((balances: AllCoinsInformationResponse[]) => {
            buildAccountAndCoinBalances(rc, balances, coinsToUpdate)
        })
        .catch((err: any) => {Logger.warn("error occurred while building account balances")});

    setInterval(() => {
        CoinUtils.getNonZeroBalances(rc)
            .then((balances: AllCoinsInformationResponse[]) => {
                buildAccountAndCoinBalances(rc, balances, coinsToUpdate)})
                    .then(() => sio.emit('balances:singleTicker', coinsToAccountBalances.get('ACCOUNT_ALL_BAL')))
            .catch((err: any) => {throw err})},
                60000);



    // publish trade counts every 30 seconds then reset counts for the next 30s cycle
    setInterval(() => {
        sio.emit('tradeStats:update', tradeCountsPerMinute);
        appData.tickerWatchlist.forEach((t: string) => tradeCountsPerMinute.set(t, 0));
    }, 30000);


    // publish 24hour ticker stats every 30 seconds
    setInterval(() => {
        sio.emit('24hrStats:update', mini24hrTickerStats);
    }, 30000);


    ws.subscribeSpotUserDataStream();

    const om = new OrderManager(rc);
    sio.on('connection', (socket: Socket) => {

        Logger.info('received socket connection');

        socket.on('prices:subscribe', function (ticker: string) {

            if(!subscribedTickers.includes(ticker)){
                try {
                    Logger.log("subscribing to real time price updates for ", ticker);
                    tradeCountsPerMinute.set(ticker, 0);
                    ws.subscribeSpotAggregateTrades(CoinUtils.convertToBinanceTicker(ticker));

                    mini24hrTickerStats.set(ticker, {open: ''});
                    ws.subscribeSymbolMini24hrTicker(CoinUtils.convertToBinanceTicker(ticker), "spot");
                    subscribedTickers.push(ticker);
                } catch (e) {
                    Logger.warn("couldn't subscribe to ticker ", ticker);
                }
            }

        });

        socket.on('balances:requestSingle', function (ticker: string) {
            const coin = CoinUtils.parseCoinFromTicker(ticker);
            const balance = coinsToAccountBalances.get(coin);
            if(balance) {
                sio.emit('balances:singleTicker', balance);
            }
        });

        socket.on('orders:new-market-order', async (order: any) => {
            Logger.info('received market order', order);
            const marketOrder = OrderUtils.convertToBinanceMarketOrder(order);
            try {
                let resp = await om.placeOrder(marketOrder);
                Logger.info('market order successfully placed', resp)
            } catch (e) {
                Logger.warn('market order failed', e)
            }
        });

        socket.on('orders:new-limitbook-order', async (order: any) => {

            Logger.info("received limit order", order);
            const limOrder = OrderUtils.convertToBinanceLimitOrder(order);

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

                limOrder.price = limitPrice; // mandatory input

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
        } else if(isWs24hrMiniTickerFormattedMessage(data)) {
            processMini24hrTicker(data);

        } else if (isWsSpotUserDataExecutionReportFormatted(data)) {
            if (data.orderStatus === 'NEW') {
                Logger.info(`received a order confirmation for ${data.symbol}`);
            } else if (data.orderStatus === 'FILLED' || data.orderStatus === 'PARTIALLY_FILLED') {
                Logger.info("received a fill for: " + data.symbol, data);
                const fill = {
                    ticker: CoinUtils.convertFromBinanceTicker(data.symbol),
                    side: data.side === 'BUY' ? 1 : -1,
                    size: data.lastTradeQuantity,
                };
                sio.emit('orders:fill', fill);
            } else if (data.orderStatus === 'CANCELED') {
                Logger.info(`received a order cancellation confirmation of ${data.quantity} ${data.symbol}`);
            } else {
                Logger.info(`received a user execution event for ${data.symbol}`, data);
            }
        }

    });

    function processMini24hrTicker(data: WsMessage24hrMiniTickerFormatted) {

        const ticker = CoinUtils.convertFromBinanceTicker(data.symbol);

        // update trade counts map
        let stats = mini24hrTickerStats.get(ticker);
        // @ts-ignore
        stats.open = data.open;
    }


    function processSpotAggregateTrades(trade: WsMessageAggTradeFormatted) {

        const price = trade.price;
        const qty = trade.quantity;

        const ticker = CoinUtils.convertFromBinanceTicker(trade.symbol);

        var priceObj = {
            "ticker": ticker,
            "price": price,
            "qty": qty,
            "notional": Math.round(price * qty)
        }

        //Logger.info(`received new trade: ticker:${trade.ticker} price:${trade.price} qty:${trade.qty} consideration:${trade.notional}`);

        const priceUpdate = handlePriceUpdate(priceObj);
        const alerts = getAlertsForPrice(priceObj.ticker, priceObj.price);

        // update trade counts map
        // @ts-ignore
        tradeCountsPerMinute.set(ticker, tradeCountsPerMinute.get(ticker) + 1);

        sio.emit('prices:update', [priceUpdate, alerts]);

    }



}

function handlePriceUpdate(priceObj: any) {

    const ticker = priceObj.ticker;
    const volumesObj = getVolumesObj(ticker);

    let newSumVol;
    if(volumesObj.queue.length < MAX_VOLUMES_QUEUE_SIZE){
        newSumVol = volumesObj.queue.reduce((r: any, v: any) => r + v, 0) + priceObj.notional;
        updateVolumesObj(volumesObj, priceObj.notional, newSumVol);

    } else {
        newSumVol = volumesObj.sum - volumesObj.queue.peek() + priceObj.notional;
        updateVolumesObj(volumesObj, priceObj.notional, newSumVol);
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




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

const { MainClient, WebsocketClient} = require('binance');

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

let subscribedTickers = []
const upalerts = new Map();
const downalerts = new Map();

const bookCostmap = new Map();

const tickersToVolObjs = new Map();
const MAX_VOLUMES_QUEUE_SIZE = 30

const tradeCountsPerMinute = new Map(); // Map<Ticker, TradeCounts>

const balanceObj = {
    totalUSDBalance: null,
    balancesMap: new Map()
};


initApp(socketio, wsClient, restClient);


http.listen(appPort, () => {
  Logger.info(`Open browser on http://localhost:${appPort}`);

});



function getAlertsForPrice(priceUpdate) {
    const uplevel = upalerts.get(priceUpdate.ticker);
    const downlevel = downalerts.get(priceUpdate.ticker);

    alertObj = {ticker: null, direction: null};
    if (uplevel != null && priceUpdate.priceObj.price > uplevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'up';
    } else if (downlevel != null && priceUpdate.priceObj.price < downlevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'down';
    } else if (uplevel != null || downlevel != null) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = null; // means not triggered or untriggered (from up or down)
    }
    return alertObj;
}

async function buildAccountAndCoinBalances(rc, allBalances, coinsToUpdate) {

    try {
        const coinToCoinBalanceMap = allBalances.reduce((p, c) => {
            p.set(c.coin, {coin: c.coin, balance: c.free, usdValue: null});
            return p;
        }, new Map());

        for (const elem of coinToCoinBalanceMap.values()) {
            const usdPrice = await getCoinUsdValue(rc, elem.coin);
            elem.usdValue = elem.balance * usdPrice;
        }


        var res = {
            totalUSDBalance: coinToCoinBalanceMap.valuesArray().reduce((p, c) => p + c.usdValue, 0),
            balancesMap: coinsToUpdate.map(t => [t, coinToCoinBalanceMap.get(CoinUtils.parseCoinFromTicker(t))])
        };

        return res;

    } catch(e){

        throw e;

    }
}

async function getCoinUsdValue(rc, coin) {

    let usdValue;

    if(coin === 'BUSD'){
        usdValue = 1;
    } else {
        try {
            const resp = await rc.getSymbolPriceTicker({symbol: coin+'BUSD'});
            usdValue = resp.price;
        } catch(e){
            throw e
        }
    }

    return usdValue;
}



function updateAppStateBalances(balancesJson) {
    balanceObj.totalUSDBalance = balancesJson.totalUSDBalance;
    balanceObj.balancesMap = balancesJson.balancesMap;
    return balanceObj;
}

function initApp(sio, ws, rc) {

    Logger.info("initialising app");

    // we add BUSD as a "ticker". This will give us the cash balance on the account
    const coinsToUpdate = appData.tickerWatchlist.concat([appData.accountCcy]);

    Logger.info('updating account and coin balances');
    CoinUtils.getNonNullBalances(rc).then(bal => {
        buildAccountAndCoinBalances(rc, bal, coinsToUpdate).then(balancesJson => updateAppStateBalances(balancesJson));
    });

    setInterval(() => {

        CoinUtils.getNonNullBalances(rc)
            .then(bal => { buildAccountAndCoinBalances(rc, bal, coinsToUpdate)
                .then(balancesJson => updateAppStateBalances(balancesJson))
                .then((balancesJson) => sio.emit('balances:update', balancesJson))});

        }, 60000);


    // initialise trade counts map
    appData.tickerWatchlist.forEach(t => tradeCountsPerMinute.set(t, 0));


    // publish and reset trade counts map every N seconds
    setInterval(() => {
        sio.emit('tradeStats:update', tradeCountsPerMinute);
        appData.tickerWatchlist.forEach(t => tradeCountsPerMinute.set(t, 0));
    }, 30000);


    ws.subscribeSpotUserDataStream();

    const om = new OrderManager(rc);
    sio.on('connection', (socket) => {

        Logger.info('received socket connection');
        sio.emit('balances:update', balanceObj);

        socket.on('price:subs', function (tickersRequested) {

            tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));

            tickersNotSubscribedYet.map((ticker) => {
                try {
                    Logger.log("subscribing to real time price updates for ", ticker);
                    ws.subscribeSpotAggregateTrades(CoinUtils.convertToBinanceTicker(ticker));
                } catch (e) {
                    Logger.warn("couldn't subscribe to ticker ", ticker);
                }
            });
            subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
            //PnL.buildCoinCostMap(tickersNotSubscribedYet, bookCostmap, ftxRestCli);

        });

        socket.on('orders:new-market-order', (order) => {
            Logger.info('received market order', order);
            const marketOrder = OrdersUtils.convertToBinanceMarketOrder(order);
            om.placeOrder(marketOrder).then(
                resp => Logger.info('order placed', resp)
            ).catch(err => Logger.warn('order placement failed', err))
        });

        socket.on('orders:new-limitbook-order', async (order) => {

            Logger.info("received limit order", order);
            const limOrder = OrdersUtils.convertToBinanceLimitOrder(order);

            let res;
            try {
                const book = await rc.getOrderBook({symbol:limOrder.symbol});

                const orderSide = limOrder.side

                if (orderSide === 'BUY') {
                    limitPrice = book.bids[2][0]; // get the third best price on the order book and use it as the order's limit price
                } else if (orderSide === 'SELL') {
                    limitPrice = book.asks[2][0];
                } else {
                    throw new Error("Order must be a BUY or SELL. Received a " + orderSide);
                }

                limOrder.price = limitPrice;

                res = await om.placeOrder(limOrder);

                Logger.info("Limit order placed", res);

            } catch(e) {
                Logger.warn("Order was not placed", e);
            }

        });

        socket.on('orders:cancel-orders', async (tkr) => {
            Logger.info("cancelling all pending orders for " + tkr);

            const ticker = CoinUtils.convertToBinanceTicker(tkr);


            try {
                const res = await om.getOpenOrders(ticker);

                if (res.length === 0) {
                    Logger.log("no pending orders found for " + ticker);
                } else {
                    res.map(o => {
                        rc.cancelOrder({symbol: o.symbol, orderId: o.orderId})
                            .then(resp => Logger.log("order cancelled", resp))
                            .catch(err => Logger.log("cancellation rejected", err));
                    });
                }

            } catch (e) {
                Logger.warn("Orders did not cancel", e);
            }
        });


        socket.on('alerts:new-alert', (alertObj) => {
            const alertsMapToUpdate = alertObj.direction === 'up' ? upalerts : downalerts;
            Logger.log(`setting up ${alertObj.direction} alert for ${alertObj.ticker} @level ${alertObj.alertlevel}`);
            alertsMapToUpdate.set(alertObj.ticker, alertObj.alertlevel);
        });
        socket.on('alerts:cancel-alerts', (ticker) => {
            Logger.info(`cancelling all alerts for ${alertObj.ticker}`);
            upalerts.delete(ticker);
            downalerts.delete(ticker);
        });


    });

    ws.on('formattedUserDataMessage', (data) => {

        if(data.eventType === 'executionReport' && data.orderStatus === 'FILLED'){
            console.info('received a new order for ' + data.symbol);
        } else if(data.eventType === 'executionReport' && data.orderStatus === 'NEW'){
            Logger.info("received a fill for: "+ data.symbol);
            const ticker = CoinUtils.convertFromBinanceTicker(data.symbol);
            const fill = {
                market: ticker,
                size: data.quantity,
            };
            sio.emit('orders:fill', fill);
        } else {
            console.info('formattedUserDataMessage channel.  unprocessed event: ', data);
        }
    });


    ws.on('message', (data) => {
        handleEvent("aggTrade", "spot", data, handleSpotAggregateTrades);
    });


    function handleEvent(event, wsMarket, data, callback) {
        if (data.e === event && data.wsMarket === wsMarket) {
            callback(data);
        } else {
            Logger.warn(`unknown event received ${data.e} ${data.wsMarket}`);
        }
    }

    function handleSpotAggregateTrades(t) {

        const price = Number.parseFloat(t.p);
        const qty = Number.parseFloat(t.q);

        ticker = CoinUtils.convertFromBinanceTicker(t.s);

        var trade = {
            "ticker": ticker,
            "price": price,
            "qty": qty,
            "cons": Math.round(price * qty)
        }

        //Logger.info(`received new trade: ticker:${trade.ticker} price:${trade.price} qty:${trade.qty} consideration:${trade.cons}`);

        const priceUpdate = handlePriceUpdate(trade);
        const alerts = getAlertsForPrice(priceUpdate);

        // update trade counts map
        tradeCountsPerMinute.set(ticker, tradeCountsPerMinute.get(ticker) + 1);

        sio.emit('price:update', [priceUpdate, alerts]);

    }



}

function handlePriceUpdate(trade) {

    const ticker = trade.ticker;
    const volumesObj = getVolumesObj(ticker);

    let newSumVol;
    if(volumesObj.queue.length < MAX_VOLUMES_QUEUE_SIZE){
        newSumVol = volumesObj.queue.reduce((r, v) => r + v, 0) + trade.cons;
        updateVolumesObj(volumesObj, trade.cons, newSumVol);

    } else {
        newSumVol = volumesObj.sum - volumesObj.queue.peek() + trade.cons;
        updateVolumesObj(volumesObj, trade.cons, newSumVol);
    }

    const sumVolumes = newSumVol;


    const bookCost = bookCostmap.get(ticker);

    priceUpdate = {
        ticker: ticker,
        priceObj: trade,
        tradeVolume: sumVolumes,
        tradesPerSecond: 0,
        bookCost: bookCost == null ? 0 : bookCost
    }

    return priceUpdate;
}


function getVolumesObj(ticker) {
    var volumesObj = tickersToVolObjs.get(ticker);
    if(volumesObj === undefined) {
        volumeQ = new Deque();
        volumesObj = {queue: volumeQ, sum: null};
        tickersToVolObjs.set(ticker, volumesObj);
    }
    return volumesObj;
}

function updateVolumesObj(volumesObj, latestVolume, newVolSum) {
    volumesObj.queue.push(latestVolume);
    volumesObj.sum = newVolSum;
    if(volumesObj.queue.length > MAX_VOLUMES_QUEUE_SIZE) {
        volumesObj.queue.shift();
    }
}


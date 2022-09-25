

const express = require("express");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);
app.use(express.static(__dirname));

const {OrderManager, Logger, CoinUtils} = require("./AppUtils");

const apikeys = require('./apikeys/apikeys.json');
if(apikeys.key === "" || apikeys.secret === "") {
    Logger.warn("Missing API keys.  Please add your api key & secret in ./apikeys/apikeys.json");
    process.exit();
}


const {WebsocketClient, RestClient} = require("ftx-api");

const ftxWS = new WebsocketClient({key: apikeys.key, secret: apikeys.secret });
const ftxRestCli = new RestClient(apikeys.key, apikeys.secret);

const {buildCoinCostMap, reBuildBookCostForTicker} = require('./PnL.js');
const appData = require("./resources/appData.json");

const Optional = require('optional-js');
const Deque = require("collections/deque");

initApp(socketio, ftxWS, ftxRestCli);

const appPort = 5001
http.listen(appPort, () => {
  Logger.info(`Open browser on http://localhost:${appPort}`);

});

let subscribedTickers = []
const upalerts = new Map();
const downalerts = new Map();

const bookCostmap = new Map();

const tickersToLast10VolQueues = new Map();
const VOLUMES_QUEUE_SIZE = 20

const balanceObj = {
    totalUSDBalance: null,
    balancesMap: new Map()
    }




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

function buildAccountAndCoinBalances(allBalances, coinsToUpdate) {

    Logger.info('updating account and coin balances');

    const coinToCoinBalanceMap =  allBalances.result.reduce((p, c) => {
        p.set(c.coin,c);
        return p;}, new Map());

    var res = {
        totalUSDBalance: allBalances.result.reduce((p, c) => p + c.usdValue, 0),
        balancesMap: coinsToUpdate.map(t => [t, coinToCoinBalanceMap.get(CoinUtils.parseCoinFromTicker(t))])
    };

    return res;
}

async function getBalances(rc) {
    return Optional.ofNullable(await rc.getBalances()
        .then(v => v)
        .catch(e => {
            Logger.warn("ERROR Getting Balances from FTX", e.message);
            return null;
        }));
}

function updateAppStateBalances(balancesJson) {
    balanceObj.totalUSDBalance = balancesJson.totalUSDBalance;
    balanceObj.balancesMap = balancesJson.balancesMap;
}

function initApp(sio, ws, rc) {

    Logger.info("initialising app");

    // we add USD as a "ticker". This will give us the cash balance on the account
    const coinsToUpdate = appData.tickerWatchlist.concat([appData.accountCcy]);


    getBalances(rc).then(v =>
        // initial account balances state
        v.map(balances =>
            buildAccountAndCoinBalances(balances, coinsToUpdate))
            .map(balancesJson => updateAppStateBalances(balancesJson)));

    setInterval(() => {
        getBalances(rc).then(v =>
            v.map(balances => buildAccountAndCoinBalances(balances, coinsToUpdate))
                .map(balancesJson => {
                    updateAppStateBalances(balancesJson);
                    Logger.info('sending account and coin balances');
                    sio.emit('balances:update', balancesJson);
                }));

    }, 60000);


    Logger.log("subscribing to fills");
    ws.subscribe({channel: 'fills'});

    const om = new OrderManager(rc);
    sio.on('connection', (socket) => {

        Logger.info('received socket connection');

        Logger.info('sending account and coin balances');
        sio.emit('balances:update', balanceObj);

        socket.on('price:subs', function(tickersRequested) {


          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));
          Logger.log('subscribing to live price updates for ', tickersNotSubscribedYet);

          topicsTrades = tickersNotSubscribedYet.map((v) => {
              return {channel: 'trades',
                        market: v}
          });

          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
          try {
            ws.subscribe(topicsTrades);
            buildCoinCostMap(tickersNotSubscribedYet, bookCostmap, ftxRestCli);
          } catch(e) {
              Logger.warn("couldn't subscribe to ticker: ", e);
          }
        });

        socket.on('orders:new-market-order', (marketOrder) => {
            Logger.info('received market order', marketOrder);
            om.placeMarketOrder(marketOrder).then(
                resp => Logger.info('order placed', resp)
            ).catch(err =>  Logger.warn('order placement failed', err))
        });
        socket.on('orders:new-limitbook-order', (limitOrder) => {
            Logger.info("placing limit order for " + limitOrder.market, limitOrder);
            om.placeLimitOrderFromOrderBook(limitOrder.market, limitOrder.side, limitOrder.size);
        });

        socket.on('orders:cancel-orders', async (tkr) => {
            Logger.info("cancelling all pending orders for " + tkr);
            const resp = await om.getOpenOrders(tkr);
            if(resp.result.length === 0) {
                Logger.log("no pending orders found for " + tkr);
            } else {
                resp.result.map(async o => {
                    Logger.log("cancelling order with id " + o.id);
                    await om.cancelOpenOrder(o.id);
                });
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





    ws.on('response', response => {
        Logger.log('received a response from ftx: ', response);
    });

    ws.on('update', async data => {
        if(data.type === "subscribed") {
            Logger.log('received a subscription confirmation for', data);
        } else if (data.type === "update") {

            if(data.channel === "trades") {
                const priceUpdate = handlePriceUpdate(data);
                const alerts = getAlertsForPrice(priceUpdate);
                sio.emit('price:update', [priceUpdate, alerts]);

            } else if(data.channel === "fills") {

                Logger.info("received a fill for: ", data);
                const ticker = data.data.market;
                const fill = {
                    market: ticker,
                    size: data.data.size
                };
                sio.emit('orders:fill', fill);

                const bal = await getBalances(rc);

                bal.map(balances => buildAccountAndCoinBalances(balances, [ticker]))
                    .map(balancesJson => {
                        Logger.info('sending account and coin balances');
                        sio.emit('balances:update', balancesJson);
                    });

                bal.map(async balances => {
                    Logger.info('update book cost for coin');
                    ftxRestCli.getOrderHistory({market: ticker})
                        .then(orderHistory =>
                            reBuildBookCostForTicker(ticker, bookCostmap, balances, orderHistory))
                        .catch(err => Logger.warn("Error getting order history from FTX", err));
                });

            }
        }
    })
}

function handlePriceUpdate(data) {

    const ticker = data.market;
    const trades = data.data;
    const largestTrade = extractLargestTrade(trades, ticker);
    const last10VolumesQ = getVolumesQueue(ticker);
    updateVolumesInQueue(trades, last10VolumesQ);
    const sumLast10Volumes = last10VolumesQ.reduce((r, v) => r + v, 0);

    const bookCost = bookCostmap.get(ticker);

    priceUpdate = {
        ticker: ticker,
        priceObj: largestTrade,
        tradeVolume: sumLast10Volumes,
        bookCost: bookCost == null ? 0 : bookCost
    }

    return priceUpdate;
}

function extractLargestTrade(trades) {
    return trades.sort((a, b) =>
            a.size - b.size
    ).slice(-1)[0]
}

function getVolumesQueue(ticker) {

    var volumeQ = tickersToLast10VolQueues.get(ticker);
    if(volumeQ === undefined) {
        const Deque = require("collections/deque");
        volumeQ = new Deque();
        tickersToLast10VolQueues.set(ticker, volumeQ);
    }
    return volumeQ;
}

function updateVolumesInQueue(trades, volumeQueue) {
    trades.forEach(t => {
        volumeQueue.push(t.size * t.price);
        if(volumeQueue.length > VOLUMES_QUEUE_SIZE) {
            volumeQueue.shift();
        }
    });
}



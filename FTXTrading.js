

const express = require("express");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);
app.use(express.static(__dirname));

const {OrderManager, Logger, CoinUtils} = require("./AppUtils");

const apikeys = require('./apikeys/apikeys.json');
if(apikeys.key === "" || apikeys.secret === "") {
    Logger.info("ERROR: Missing API keys.  There are no api key/secret in /apikeys/apikeys.json");
    process.exit();
}


const {WebsocketClient, RestClient} = require("ftx-api");

const ftxWS = new WebsocketClient({key: apikeys.key, secret: apikeys.secret });
const ftxRestCli = new RestClient(apikeys.key, apikeys.secret);

const {buildCoinCostMap, reBuildBookCostForTicker} = require('./PnL.js');


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


async function updateBalances(tblTickers, ftxRestCli, sio) {
    const balances = await ftxRestCli.getBalances();
    const coinToBalance =  balances.result.reduce((p, c) => {
        p.set(c.coin,c);
        return p;}, new Map());

    const balancesMap = tblTickers.map(t => [t, coinToBalance.get(CoinUtils.parseCoinFromTicker(t))]);

    if(balancesMap.length === 1){
        sio.emit('balances:singleupdate', balancesMap);
    } else {
        sio.emit('balances:update', balancesMap);
    }
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

function initApp(sio, ws, rc) {

    const om = new OrderManager(rc);

    ws.subscribe({channel: 'fills'});

    sio.on('connection', (socket) => {
        socket.on('price:subs', function(tickersRequested) {


          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));
          Logger.log('subscribing to live price updates for ', tickersNotSubscribedYet);

          topicsTrades = tickersNotSubscribedYet.map((v) => {
              return {channel: 'trades',
                        market: v}
          });

          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
          ws.subscribe(topicsTrades);

          buildCoinCostMap(tickersNotSubscribedYet, bookCostmap, ftxRestCli);

        });

        socket.on('orders:new-market-order', (marketOrder) => {
            Logger.info('received market order', marketOrder);
            om.placeMarketOrder(marketOrder).then(
                resp => {
                    Logger.info('order executed', resp);
                    reBuildBookCostForTicker(resp.result.market, bookCostmap, ftxRestCli);
                    updateBalances([resp.result.market], rc, sio);
                    }
            ).catch(err =>  Logger.warn('order execution failed', err))
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


        socket.on('alerts:up-alert', (alertObj) => {
            Logger.log(`setting up UP alert for ${alertObj.ticker} @level ${alertObj.alertlevel}`);
            upalerts.set(alertObj.ticker, alertObj.alertlevel);
        });
        socket.on('alerts:down-alert', (alertObj) => {
            Logger.info(`setting up DOWN alert for ${alertObj.ticker} @level ${alertObj.alertlevel}`);
            downalerts.set(alertObj.ticker, alertObj.alertlevel);
        });
        socket.on('alerts:cancel-alerts', (ticker) => {
            Logger.info(`cancelling all alerts for ${alertObj.ticker}`);
            upalerts.delete(ticker);
            downalerts.delete(ticker);
        });

        socket.on('balances:get', async (tblTickers) => {
            try {
                Logger.info('updating all coin balances');
                await updateBalances(tblTickers, rc, sio);

            } catch (e) {
                Logger.log("ERROR Getting Balances from FTX", e.message);
            }
            });
        });




    ws.on('response', response => {
        Logger.log('response', response);
    });

    ws.on('update', data => {
        if(data.type === "subscribed") {
            Logger.log('received a subscription confirmation for', data);
        } else if (data.type === "update") {
            if(data.channel === "trades") {
                const priceUpdate = handlePriceUpdate(data);
                const alerts = getAlertsForPrice(priceUpdate);
                sio.emit('price:update', [priceUpdate, alerts]);


            } else if(data.channel === "fills") {
                Logger.info("received a fill for: ", data);
                const fill = {market: data.data.market,
                            size: data.data.size};
                sio.emit('orders:fill', fill);
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



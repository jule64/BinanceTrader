

const express = require("express");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);
app.use(express.static(__dirname));

const {OrderManager, Logger, CoinUtils} = require("./AppUtils");

const apikey = process.env.APIKEY || 'APIKEY';
const apisecret = process.env.APISECRET || 'APISECRET';

const { WebsocketClient } = require('binance');
const wsClient = new WebsocketClient(
  {
    api_key: apikey,
    api_secret: apisecret,
    beautify: true,
  }
);

const appData = require("./resources/appData.json");

const Optional = require('optional-js');
const Deque = require("collections/deque");

initApp(socketio, wsClient);

const appPort = 5001
http.listen(appPort, () => {
  Logger.info(`Open browser on http://localhost:${appPort}`);

});

let subscribedTickers = []
const upalerts = new Map();
const downalerts = new Map();

const bookCostmap = new Map();

const tickersToVolObjs = new Map();
const MAX_VOLUMES_QUEUE_SIZE = 50

const balanceObj = {
    totalUSDBalance: 10000,
    balancesMap: new Map([["USD", {usdValue: 10000}]])
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

function initApp(sio, ws) {

    Logger.info("initialising app");


    sio.on('connection', (socket) => {

        Logger.info('received socket connection');

        Logger.info('sending account and coin balances');
        sio.emit('balances:update', balanceObj);

        socket.on('price:subs', function(tickersRequested) {

          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));

          tickersNotSubscribedYet.map((ticker) => {
                 try {
                    Logger.log("subscribing to real time price updates for ", ticker);
                    ws.subscribeSpotAggregateTrades(ticker);
                  } catch(e) {
                      Logger.warn("couldn't subscribe to ticker ", ticker);
                  }
          });

          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
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



    ws.on('message', (data) => {
      handleEvent("aggTrade", "spot", data, handleSpotAggregateTrades);
    });


    function handleEvent(event, wsMarket, data, callback) {
        if(data.e === event & data.wsMarket === wsMarket){
            callback(data);
        } else {
            Logger.warn(`unknown event received ${data.e} ${data.wsMarket}`);
        }
    }

    function handleSpotAggregateTrades(t){

        const price = Number.parseFloat(t.p);
        const qty = Number.parseFloat(t.q);

        var trade = {
            "ticker": t.s,
            "price": price,
            "qty": qty,
            "cons": Math.round(price * qty)
        }

        //Logger.info(`received new trade: ticker:${trade.ticker} price:${trade.price} qty:${trade.qty} consideration:${trade.cons}`);

        const priceUpdate = handlePriceUpdate(trade);
        const alerts = getAlertsForPrice(priceUpdate);
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

    const avgVolumes = newSumVol / volumesObj.queue.length;


    const bookCost = bookCostmap.get(ticker);

    priceUpdate = {
        ticker: ticker,
        priceObj: trade,
        tradeVolume: avgVolumes,
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



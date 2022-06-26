

const express = require("express")
const app = express()

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);



apicreds = {
    "KEY": "",
    "SECRET": ""
}
const {WebsocketClient, RestClient} = require("ftx-api");
const ftxWS = new WebsocketClient({key: apicreds.KEY, secret: apicreds.SECRET });
const ftxRestCli = new RestClient(apicreds.KEY, apicreds.SECRET);


let subscribedTickers = []

app.use(express.static(__dirname))


const upalerts = new Map();
const downalerts = new Map();


async function updateBalances(tblTickers, ftxRestCli, sio) {
    const balances = await ftxRestCli.getBalances();
    const coinToBalance =  balances.result.reduce((p, c) => {
        p.set(c.coin,c);
        return p;}, new Map());

    const balancesMap = tblTickers.map(t => [t, coinToBalance.get(t.split('/')[0])]);

    if(balancesMap.length === 1){
        sio.emit('balances:singleupdate', balancesMap);
    } else {
        sio.emit('balances:update', balancesMap);
    }
}

function initFTXOps(sio, ws, rc) {

      sio.on('connection', (socket) => {
        socket.on('price:subs', function(tickersRequested) {


          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));
          console.log('subscribing to live price updates for ', tickersNotSubscribedYet);

          topics = tickersNotSubscribedYet.map((v) => {
              return {'channel': 'trades',
              'market': v}
          })
          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
          ws.subscribe(topics);

        });

        socket.on('orders:new-morder', (marketOrder) => {
            console.info('received market order', marketOrder);
            rc.placeOrder(marketOrder).then(
                resp => {
                    console.info('order executed', resp);
                    updateBalances([resp.result.market], rc, sio);
                    },
                resp =>  console.warn('order execution failed', resp)
            );
        });

        socket.on('alerts:up-alert', (alertObj) => {
            upalerts.set(alertObj.ticker, alertObj.alertlevel)
        });
        socket.on('alerts:down-alert', (alertObj) => {
            downalerts.set(alertObj.ticker, alertObj.alertlevel)
        });
        socket.on('alerts:cancel-alerts', (ticker) => {
            upalerts.delete(ticker)
            downalerts.delete(ticker)
        });

        socket.on('balances:get', async (tblTickers) => {
            try {
                updateBalances(tblTickers, rc, sio);

            } catch (e) {
                console.log(e);
            }
            });
        });




    ws.on('response', response => {
        console.log('response', response);
    });

    ws.on('update', data => {
        // this is still printing even with debug level set to false..
        // console.debug(`update:${data.type}`, data);
        if(data.type === "subscribed") {
            console.log('received a subscription confirmation for', data);
        } else if (data.type === "update") {
            if(data.channel === "trades") {
                largestTrade = extractLargestTrade(data.data)
                priceUpdate = {
                    ticker : data.market,
                    priceObj: largestTrade,
                    tradeVolume: largestTrade.price * largestTrade.size
                }

                const uplevel = upalerts.get(priceUpdate.ticker);
                const downlevel = downalerts.get(priceUpdate.ticker);

                alertObj = { ticker: null, direction: null};
                if(uplevel != null && priceUpdate.priceObj.price > uplevel){
                    alertObj.ticker = priceUpdate.ticker;
                    alertObj.direction = 'up';
                } else if(downlevel != null && priceUpdate.priceObj.price < downlevel){
                    alertObj.ticker = priceUpdate.ticker;
                    alertObj.direction = 'down';
                } else if(uplevel != null || downlevel != null) {
                    alertObj.ticker = priceUpdate.ticker;
                    alertObj.direction = null; // means not triggered or untriggered (from up or down)
                }
                sio.emit('price:update', [priceUpdate, alertObj]);

            } else if(data.channel === "fills") {
                console.warn('fills events not handled yet');

            }
        }
    })
}


function extractLargestTrade(trades) {
    return trades.sort((a, b) =>
            a.size - b.size
    ).slice(-1)[0]
}

const appPort = 5001
http.listen(appPort, () => {
  console.info(`Server is up and running on ${appPort} ...`);
  initFTXOps(socketio, ftxWS, ftxRestCli)
});


const {CancelOrderParams} = require("binance/lib/types/shared");

class OrderManager {

    constructor(restClient) {
        this.rc = restClient;
    }


    async placeLimitOrderFromOrderBook(order){
        let limitPrice;

        const ob = (await this.rc.getOrderbook({marketName:ticker, depth:3})).result;
        if(direction === 'buy') {
            limitPrice = ob.bids[2][0];
        } else if(direction === 'sell') {
            limitPrice = ob.asks[2][0];
        } else {
            throw new Error("Order must be a buy or sell. got a " + direction);
        }

        this.placeLimitOrder(ticker, direction, size, limitPrice);

    }

    placeLimitOrder(ticker, direction, size, limitPrice){

        const limitOrder = {
            market: ticker,
            side: direction,
            price: limitPrice,
            type: "limit",
            size: size,
            postOnly: true
        }

        this.rc.placeOrder(limitOrder)
            .then(resp => Logger.log("order placed", resp))
            .catch(err => Logger.log("order rejected", err));

    }

    getOpenOrders(ticker) {

        const openOrderObj = {symbol: ticker};

        return this.rc.getOpenOrders(openOrderObj);
    }

    placeOrder(marketOrder) {

        return this.rc.submitNewOrder(marketOrder);
    }
}
class OrdersUtils {

    static convertToBinanceMarketOrder(o) {
        const ticker = CoinUtils.convertToBinanceTicker(o.market);

        return {
            symbol: ticker,
            side: o.side.toUpperCase(),
            type: "MARKET",
            quantity: o.size,
        };


    }

    static convertToBinanceLimitOrder(o) {
        const ticker = CoinUtils.convertToBinanceTicker(o.market);

        return {
            symbol: ticker,
            side: o.side.toUpperCase(),
            type: "LIMIT",
            quantity: o.size,
            price: null,
            timeInForce: 'GTC'
        };


    }


}

class CoinUtils {
    static parseCoinFromTicker(ticker) {
        return ticker.split('/')[0];
    }

    static convertToBinanceTicker(ticker) {
        return ticker.replace("/","");
    }

    static convertFromBinanceTicker(binanceTicker) {
        return binanceTicker.split("BUSD")[0]+"/BUSD";
    }

    static async getNonNullBalances(rc) {
        try {
            const balances = await rc.getBalances();
            return balances.filter(v => v.free > 0);
        } catch (e) {
            console.log(e);
        }
    }

    static getBalanceFor(coin, accountBalances) {
        let res = accountBalances.filter(v => v.coin === coin);
        return res.length > 0 ? res[0] : null;
    }
}



class Logger {

    static info(msg, arg) {
        this._log(console.info, msg, arg);
    }

    static warn(msg, arg) {
        this._log(console.warn, msg, arg);
    }

    static log(msg, arg) {
        this._log(console.log, msg, arg);
    }

    static _log(fun, msg, arg) {
        if(arg === undefined){
            fun(this.wrapMessageWithTimeStampAndAppName(msg));
        } else {
            fun(this.wrapMessageWithTimeStampAndAppName(msg), arg);
        }
    }


    static wrapMessageWithTimeStampAndAppName(msg) {
        const timeStr = new Date().toLocaleTimeString();
        return `${timeStr}: BinanceTrader: ${msg}`;
    }

}


module.exports = {OrderManager, Logger, CoinUtils, OrdersUtils}
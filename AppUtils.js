
class OrderManager {

    constructor(restClient) {
        this.rc = restClient;
    }


    async placeLimitOrderFromOrderBook(ticker, direction, size){
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
        return this.rc.getOpenOrders(ticker);
    }

    cancelOpenOrder(orderId) {
            this.rc.cancelOrder(orderId)
                .then(resp => Logger.log("order canceled"))
                .catch(err => Logger.log("cancellation rejected (order filled?)"));
    }

    placeMarketOrder(marketOrder) {
        return this.rc.placeOrder(marketOrder);
    }
}

class CoinUtils {
    static parseCoinFromTicker(ticker) {
        return ticker.split('/')[0];
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


module.exports = {OrderManager, TestUtils, Logger, CoinUtils}
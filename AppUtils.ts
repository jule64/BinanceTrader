import {AllCoinsInformationResponse, MainClient, OrderType} from "binance";
import {NewSpotOrderParams} from "binance/lib/types/spot";

class OrderManager {
    private rc: MainClient;

    constructor(restClient: MainClient) {
        this.rc = restClient;
    }

    getOpenOrders(ticker: string) {

        const openOrderObj = {symbol: ticker};

        return this.rc.getOpenOrders(openOrderObj);
    }

    placeOrder(order: NewSpotOrderParams) {

        return this.rc.submitNewOrder(order);
    }
}
class OrderUtils {

    static convertToBinanceMarketOrder(o: any): NewSpotOrderParams {
        const ticker = CoinUtils.convertToBinanceTicker(o.market);

        return {
            symbol: ticker,
            side: o.side.toUpperCase(),
            type: "MARKET",
            quantity: o.size,
        };


    }

    static convertToBinanceLimitOrder(o: any): NewSpotOrderParams {
        const ticker = CoinUtils.convertToBinanceTicker(o.market);

        return {
            symbol: ticker,
            side: o.side.toUpperCase(),
            type: "LIMIT",
            quantity: o.size,
            timeInForce: 'GTC'
        };


    }


}

class CoinUtils {
    static parseCoinFromTicker(ticker: string) {
        return ticker.split('/')[0];
    }

    static convertToBinanceTicker(ticker: string) {
        return ticker.replace("/","");
    }

    static convertFromBinanceTicker(binanceTicker: string) {
        return binanceTicker.split("BUSD")[0]+"/BUSD";
    }

    static getNonZeroBalances(rc: MainClient): Promise<AllCoinsInformationResponse[]> {
        return rc.getBalances().then(v => v.filter(v => v.free > 0));
    }
}



class Logger {

    static loggerName = "BinanceTrader"

    static info(msg: string, arg: any) {
        this._log(console.info, msg, arg);
    }

    static warn(msg: string, arg: any) {
        this._log(console.warn, msg, arg);
    }

    static log(msg: string, arg: any) {
        this._log(console.log, msg, arg);
    }

    static _log(fun: any, msg: string, arg: any) {
        if(arg === undefined){
            fun(this.wrapMessageWithTimeStampAndAppName(msg));
        } else {
            fun(this.wrapMessageWithTimeStampAndAppName(msg), arg);
        }
    }


    static wrapMessageWithTimeStampAndAppName(msg: string) {
        const timeStr = new Date().toLocaleTimeString();
        return `${timeStr}: ${this.loggerName}: ${msg}`;
    }

}


module.exports = {OrderManager, Logger, CoinUtils, OrderUtils}
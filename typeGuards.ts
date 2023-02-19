import {
    WsFormattedMessage, WsMessage24hrMiniTickerFormatted,
    WsMessageAggTradeFormatted,
    WsMessageSpotUserDataExecutionReportEventFormatted,
    WsUserDataEvents
} from "binance/lib/types/websockets";

export function isWsSpotUserDataExecutionReportFormatted(data: WsFormattedMessage):
    data is WsMessageSpotUserDataExecutionReportEventFormatted {
    return !Array.isArray(data) && data.eventType === 'executionReport';
}

/**
 * Typeguard to validate a 'Compressed/Aggregate' Trade
 */
export function isWsAggTradeFormatted(data: WsFormattedMessage): data is WsMessageAggTradeFormatted {
    return !Array.isArray(data) && data.eventType === 'aggTrade';
}

export function isWs24hrMiniTickerFormattedMessage(data: WsFormattedMessage): data is WsMessage24hrMiniTickerFormatted {
    return !Array.isArray(data) && data.eventType === '24hrMiniTicker';
}

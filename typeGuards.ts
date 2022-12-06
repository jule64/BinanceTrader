import {
    WsFormattedMessage,
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


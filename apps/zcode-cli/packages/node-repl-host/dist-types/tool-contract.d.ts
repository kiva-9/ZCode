import type { Tool } from "@modelcontextprotocol/server";
export declare const NODE_REPL_DEFAULT_TIMEOUT_MS = 60000;
export declare const NODE_REPL_SERVER_VERSION = "0.6.0";
/**
 * Computer Use 可用/不可用两种形态下的补充说明。
 *
 * 为什么必须区分（真机教训）：驱动缺失时，如果工具描述对此**只字不提**，模型看到的
 * 唯一线索是运行时那句点名包名的 "Cannot find package '@trycua/cua-driver'"。
 * 那会诱导它去 npm install 一个自己猜出来的包。不可用时要把「没有东西需要安装」
 * 写进描述里，让模型第一步就去告诉用户开启插件。
 */
export declare function withComputerUseAvailabilityNote(instructions: string, options: {
    computerUseEnabled: boolean;
}): string;
export declare function buildNodeReplTools(options: {
    computerUseEnabled: boolean;
}): Tool[];
/** 不可用时的后缀：明确「没有东西需要安装」，堵住自我安装这条路径。 */
export declare const JS_TOOL_DESCRIPTION_COMPUTER_USE_DISABLED_SUFFIX: string;
export declare const NODE_REPL_SERVER_INSTRUCTIONS: string;
export declare const JS_TOOL_DESCRIPTION: string;
//# sourceMappingURL=tool-contract.d.ts.map
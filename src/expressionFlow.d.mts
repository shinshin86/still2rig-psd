import type {ExpressionDefinition} from './expressions.mjs';
export interface ExpressionRequestGroup {id:string;label:string;parts:string[]}
export const expressionRequestGroups:ReadonlyArray<ExpressionRequestGroup>;
export function expressionArtworkLabel(name:string):string;
export function expressionGroupState(group:ExpressionRequestGroup,parts:Iterable<string>):{present:string[];missing:string[];complete:boolean};
export function selectedExpressionArtwork(ids:string[],parts:Iterable<string>,redraw?:boolean):ExpressionDefinition[];
export function expressionFlowRequest(options:{jobId:string;name:string;recipient:'codex'|'claude';groupIds:string[];parts:Iterable<string>;redraw?:boolean}):string;

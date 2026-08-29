import type { DebeziumMapping } from "../contracts/cache-config.interface.js";
import { logger } from "../../observability/logger/logger.js";

export class DebeziumInvalidator {
  constructor(
    private mappings: DebeziumMapping[],
    private invalidateFn: (pattern: string) => Promise<void>,
  ){}
  async handle(eventJson: string): Promise<void> {
    try {
      const event = JSON.parse(eventJson);
      const op = event.op;
      if(op && !["c", "u", "d", "r"].includes(op)) return;
      const tableName =
        event.source?.table ?? event.source?.collection ?? "";
      if(!tableName) return;
      const parseObj = (val: any) => {
        if(typeof val === "string"){
          try {
            return JSON.parse(val);
          } catch {
            return null;
          }
        }
        return val;
      };
      const before = parseObj(event.before);
      const after = parseObj(event.after);
      const patch = parseObj(event.patch);
      const getVal = (obj: any, keys: string[]): string | undefined => {
        if(!obj) return undefined;
        for(const k of keys){
          if(obj[k] !== undefined){
            const val = obj[k];
            if(val && typeof val === "object" && val["$oid"] !== undefined){
              return String(val["$oid"]);
            }
            return String(val);
          }
        }
        return undefined;
      };
      const recordId =
        getVal(before, ["id", "_id"]) ??
        getVal(after, ["id", "_id"]) ??
        getVal(patch, ["id", "_id"]) ??
        getVal(event, ["id", "_id"]);
       if(!recordId){
         return ; 
       }
      logger.info(
        "Cache",
        `Debezium CDC change detected: table=${tableName}, id=${recordId}`,
      );
      const matched = this.mappings.filter((m) => m.table === tableName);
      if(matched.length > 0){
        for(const m of matched){
          const resolvedPath = m.pathPattern.replace("{id}", recordId);
          await this.invalidateFn(resolvedPath);
        }
      }
      else {
        await this.invalidateFn(`*${tableName}*${recordId}*`);
        await this.invalidateFn(`*${recordId}*`);
      }
    } catch (err: any){
      logger.error("Cache", `Debezium event parse failed: ${err.message}`);
    }
  }
}

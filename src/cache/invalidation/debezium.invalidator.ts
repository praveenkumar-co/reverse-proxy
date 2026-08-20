import type { DebeziumMapping } from "../contracts/cache-config.interface.js";

export class DebeziumInvalidator {
  constructor(
    private mappings: DebeziumMapping[],
    private invalidateFn: (pattern: string) => Promise<void>
  ) {}

  async handle(eventJson: string): Promise<void> {
    const event = JSON.parse(eventJson);
    const op = event.op;
    if(!['c', 'u', 'd', 'r'].includes(op)) return;
    const tableName = event.source?.table ?? event.source?.collection;
    const record = event.after ?? event.before ?? {};
    let id: string | undefined;
    if(record._id) {
      id = typeof record._id === 'object' ? record._id.$oid : String(record._id);
    } else if (record.id !== undefined){
      id = String(record.id);
    }
    const mapping = this.mappings.find(m => m.table === tableName);
    if(mapping && id) {
      const path = mapping.pathPattern.replace('{id}', id);
      await this.invalidateFn(path);
    } else if(tableName && id){
      await this.invalidateFn(`*${tableName}*${id}*`);
      await this.invalidateFn(`*${id}*`);
    }
  }
}

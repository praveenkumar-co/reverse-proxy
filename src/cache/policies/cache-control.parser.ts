export interface CacheControlDirectives {
  noStore: boolean;
  noCache: boolean;
  maxAge?: number;
  sMaxAge?: number;
  private: boolean;
}

export function parseCacheControl(header: string): CacheControlDirectives {
  const parts = header.split(',').map(p => p.trim());
  const result: CacheControlDirectives = { noStore: false, noCache: false, private: false };
  for(const part of parts){
    if(part === 'no-store') result.noStore = true;
    else if(part === 'no-cache') result.noCache = true;
    else if(part === 'private') result.private = true;
    else if(part.startsWith('max-age=')) result.maxAge = parseInt(part.split('=')[1]!, 10);
    else if(part.startsWith('s-maxage=')) result.sMaxAge = parseInt(part.split('=')[1]!, 10);
}
return result; 
}
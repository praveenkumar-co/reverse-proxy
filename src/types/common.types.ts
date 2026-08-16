export type Maybe<T> = T | null | undefined;
export type AsyncOrSync<T> = T | Promise<T>;
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Result<T, E = Error> {
  ok: boolean;
  value?: T;
  error?: E;
}

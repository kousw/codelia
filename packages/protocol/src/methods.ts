import type { CatalogMethod } from "./catalog";

/**
 * Methods not yet in the catalog. A method moves from here to
 * `protocolMethods` in the change that catalogues it.
 */
export type LegacyMethod = never;

export type ProtocolMethod = CatalogMethod | LegacyMethod;

type Assert<T extends true> = T;
/** Fails to compile when a method is listed in both places. */
export type _NoDuplicateProtocolMethod = Assert<
	[Extract<LegacyMethod, CatalogMethod>] extends [never] ? true : false
>;

import type {
	ResolveStorageOptions,
	StoragePathService,
	StoragePaths,
} from "@codelia/core";
import { resolveStoragePaths } from "./paths";

export class StoragePathServiceImpl implements StoragePathService {
	resolvePaths(options: ResolveStorageOptions = {}): StoragePaths {
		return resolveStoragePaths(options);
	}
}

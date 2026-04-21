import { getConfigRootDir } from "@ohp/utils";

export function filterUserExtensions<T extends { path: string }>(extensions: T[]): T[] {
	const configRoot = getConfigRootDir();
	return extensions.filter(ext => !ext.path.startsWith(configRoot));
}

export function filterUserExtensionErrors<T extends { path: string }>(errors: T[]): T[] {
	const configRoot = getConfigRootDir();
	return errors.filter(err => !err.path.startsWith(configRoot));
}

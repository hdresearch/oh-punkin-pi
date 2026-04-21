/**
 * Process management utilities.
 */

import { setNativeKillTree } from "@ohp/utils";
import { native } from "../native";

setNativeKillTree(native.killTree);

export const { killTree, listDescendants } = native;

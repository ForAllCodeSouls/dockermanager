import type { SystemVersion } from "@dockermanager/shared";

export const version: SystemVersion = {
  version: process.env.APP_VERSION ?? "dev",
  commit: process.env.APP_COMMIT ?? "unknown",
  buildTime: process.env.APP_BUILD_TIME ?? "unknown",
  image: process.env.IMAGE_NAME ?? "",
  imageId: null,
  startedAt: new Date().toISOString(),
  node: process.version,
};

import multer from "multer";

const MAX_BYTES = 25 * 1024 * 1024;

export const uploadSingle = (fieldName: string) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
  }).single(fieldName);

export const uploadFields = (fields: { name: string; maxCount?: number }[]) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 4 },
  }).fields(fields);

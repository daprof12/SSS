// Object storage adapter for uploaded documents. The API stores metadata only;
// the client uploads the file straight to storage with a short-lived URL.
import { randomUUID } from 'node:crypto';

export interface UploadTicket {
  storageKey: string;
  method: 'PUT';
  url: string;
  expiresInSeconds: number;
}

export interface StorageAdapter {
  presignUpload(prefix: string, contentType: string): Promise<UploadTicket>;
}

export const STORAGE = Symbol('STORAGE');

export class MockStorageAdapter implements StorageAdapter {
  constructor(private readonly baseUrl: string) {}

  async presignUpload(prefix: string, _contentType: string): Promise<UploadTicket> {
    const storageKey = `${prefix}/${randomUUID()}`;
    return { storageKey, method: 'PUT', url: `${this.baseUrl}/dev/storage/${storageKey}`, expiresInSeconds: 900 };
  }
}

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const useLocal = !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_BUCKET_NAME;

const s3 = useLocal ? null : new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  region: process.env.AWS_REGION || 'us-east-1',
});

const LOCAL_STORAGE_DIR = path.join(__dirname, '../../storage');

if (useLocal && !fs.existsSync(LOCAL_STORAGE_DIR)) {
  fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

export async function uploadReplayData(replayId: string, data: any): Promise<string> {
  const content = typeof data === 'string' ? data : JSON.stringify(data);

  if (!s3) {
    const filePath = path.join(LOCAL_STORAGE_DIR, `${replayId}.json`);
    await fs.promises.writeFile(filePath, content, 'utf8');
    return `local://${replayId}.json`;
  }

  const bucket = process.env.AWS_BUCKET_NAME!;
  const key = `replays/${replayId}.json`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: 'application/json',
  }));

  return `s3://${bucket}/${key}`;
}

export async function fetchReplayData(dataUrl: string): Promise<any> {
  if (dataUrl.startsWith('local://')) {
    const filename = dataUrl.replace('local://', '');
    const filePath = path.join(LOCAL_STORAGE_DIR, filename);
    const content = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(content);
  }

  if (dataUrl.startsWith('s3://')) {
    const s3Path = dataUrl.replace('s3://', '');
    const parts = s3Path.split('/');
    const bucket = parts[0];
    const key = parts.slice(1).join('/');

    if (!s3) {
      throw new Error('S3 client not initialized but attempted to read s3:// URL');
    }

    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const content = await res.Body?.transformToString();
    if (!content) throw new Error('Empty file content from S3');
    return JSON.parse(content);
  }

  throw new Error(`Unsupported storage URL scheme: ${dataUrl}`);
}

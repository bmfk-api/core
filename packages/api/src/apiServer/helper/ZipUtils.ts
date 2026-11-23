import zlib from "zlib";

export class ZipUtils{

	static zipBufferToBase64 = (input: Buffer): string => {
		const compressed = zlib.gzipSync(input);
		return compressed.toString("base64");
	};

	static unzipBase64ToBuffer = (base64: string): Buffer => {
		const compressed = Buffer.from(base64, "base64");
		return zlib.gunzipSync(compressed);
	};

	static zipStringToBase64 = (input: string): string => {
		const buffer = Buffer.from(input, "utf-8");
		const compressed = zlib.gzipSync(buffer);
		return compressed.toString("base64");
	};

	static unzipBase64ToString = (base64: string): string => {
		const compressed = Buffer.from(base64, "base64");
		const uncompressed = zlib.gunzipSync(compressed);
		return uncompressed.toString("utf-8");
	};
}

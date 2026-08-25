import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";

describe("package metadata", () => {
	it("prepares the extension without a desktop-notify dependency", () => {
		// Version moves on every release; pinning it here broke CI each bump.
		// Assert shape instead of a literal.
		expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageJson.pi.extensions).toEqual(["./src/index.ts"]);
		expect(JSON.stringify(packageJson)).not.toContain(
			"@gamaraan/desktop-notify",
		);
	});
});

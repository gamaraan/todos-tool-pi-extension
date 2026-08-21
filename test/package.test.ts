import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";

describe("package metadata", () => {
	it("prepares the 0.2.2 extension without a desktop-notify dependency", () => {
		expect(packageJson.version).toBe("0.2.2");
		expect(packageJson.pi.extensions).toEqual(["./src/index.ts"]);
		expect(JSON.stringify(packageJson)).not.toContain(
			"@gamaraan/desktop-notify",
		);
	});
});

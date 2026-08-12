/**
 * Test helpers: build a synthetic Theme for renderer tests. The real Theme
 * singleton is not exported from the pi package index; the constructor needs
 * every color key, so tests supply a uniform placeholder palette (renderer
 * tests assert stripped text and structural ANSI like strikethrough, not
 * specific colors).
 */

import { Theme } from "@earendil-works/pi-coding-agent";

const FG_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"searchMatchText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
] as const;

const BG_COLORS = [
	"selectedBg",
	"scrollbarThumb",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;

export function makeTestTheme(): Theme {
	const fgColors = Object.fromEntries(
		FG_COLORS.map((color) => [color, "#888888"]),
	) as Record<(typeof FG_COLORS)[number], string>;
	const bgColors = Object.fromEntries(
		BG_COLORS.map((color) => [color, "#222222"]),
	) as Record<(typeof BG_COLORS)[number], string>;
	return new Theme(fgColors, bgColors, "truecolor");
}

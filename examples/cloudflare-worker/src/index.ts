import { PKPass } from "passkit-generator";
import { Buffer } from "node:buffer";

import icon from "../../models/gymMembership.pass/icon.png";
import icon2x from "../../models/gymMembership.pass/icon@2x.png";
import logo from "../../models/gymMembership.pass/logo.png";
import logo2x from "../../models/gymMembership.pass/logo@2x.png";

export interface Env {
	WWDR: string;
	SIGNER_CERT: string;
	SIGNER_KEY: string;
	SIGNER_PASSPHRASE: string;
	ACCESS_TOKEN: string;
	ALLOWED_ORIGINS: string; // comma-separated, e.g. "https://wallet.bvyan.com,http://localhost:5173"
	ASSETS: Fetcher;
}

// In-memory rate limiter — 1 request per IP per 10 seconds
const rateLimits = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const last = rateLimits.get(ip) ?? 0;
	if (now - last < RATE_LIMIT_MS) return true;
	rateLimits.set(ip, now);
	// Prune entries older than the cooldown window to prevent unbounded growth
	for (const [key, ts] of rateLimits) {
		if (now - ts >= RATE_LIMIT_MS) rateLimits.delete(key);
	}
	return false;
}

function getGymStatus(): { status: string; hours: string } {
	const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
	const day = now.getDay();
	const hour = now.getHours() + now.getMinutes() / 60;

	let open: number;
	let close: number;
	let hours: string;

	if (day >= 1 && day <= 4) {
		open = 4.5; close = 22;
		hours = "4:30am - 10:00pm";
	} else if (day === 5) {
		open = 4.5; close = 20;
		hours = "4:30am - 8:00pm";
	} else {
		open = 6; close = 18;
		hours = "6:00am - 6:00pm";
	}

	return {
		status: hour >= open && hour < close ? "Open" : "Closed",
		hours,
	};
}

interface MemberData {
	name: string;
	id: string;
	memberSince: string;
}

function corsHeaders(origin: string) {
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get("Origin") ?? "";
		const allowedOrigins = env.ALLOWED_ORIGINS
			? env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
			: [];

		// ── OPTIONS preflight ──────────────────────────────────────────────
		if (request.method === "OPTIONS") {
			if (!allowedOrigins.includes(origin)) {
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}

		// ── GET /?token= — direct Safari / browser link ───────────────────
		if (request.method === "GET" && url.pathname === "/") {
			const token = url.searchParams.get("token");
			if (token && token === env.ACCESS_TOKEN) {
				return generatePass(env, {
					name: "Bryan Contreras",
					id: "100004968",
					memberSince: "March 9, 2026",
				});
			}
			return env.ASSETS.fetch(request);
		}

		// ── POST /api/pass — frontend form ────────────────────────────────
		if (request.method === "POST" && url.pathname === "/api/pass") {
			if (!allowedOrigins.includes(origin)) {
				return new Response("Forbidden", { status: 403 });
			}

			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			if (isRateLimited(ip)) {
				return new Response("Too many requests", {
					status: 429,
					headers: corsHeaders(origin),
				});
			}

			let member: MemberData;
			try {
				member = await request.json<MemberData>();
			} catch {
				return new Response("Bad request", {
					status: 400,
					headers: corsHeaders(origin),
				});
			}

			if (
				!member.name || member.name.length > 100 ||
				!member.id || !/^\d{6,12}$/.test(member.id) ||
				!member.memberSince || member.memberSince.length > 50
			) {
				return new Response("Bad request", {
					status: 400,
					headers: corsHeaders(origin),
				});
			}

			const passResponse = await generatePass(env, member);
			// Attach CORS headers to the pass response
			const headers = new Headers(passResponse.headers);
			for (const [k, v] of Object.entries(corsHeaders(origin))) {
				headers.set(k, v);
			}
			return new Response(passResponse.body, {
				status: passResponse.status,
				headers,
			});
		}

		// ── Everything else → static assets ───────────────────────────────
		return env.ASSETS.fetch(request);
	},
};

async function generatePass(env: Env, member: MemberData) {
	const pass = new PKPass(
		{
			"icon.png": Buffer.from(icon),
			"icon@2x.png": Buffer.from(icon2x),
			"logo.png": Buffer.from(logo),
			"logo@2x.png": Buffer.from(logo2x),
		},
		{
			signerCert: env.SIGNER_CERT,
			signerKey: env.SIGNER_KEY,
			signerKeyPassphrase: env.SIGNER_PASSPHRASE,
			wwdr: env.WWDR,
		},
		{
			description: "Evolutions Fitness & Wellness Center Membership",
			serialNumber: member.id,
			passTypeIdentifier: "pass.bvyan.com",
			teamIdentifier: "C2G8UXXA46",
			organizationName: "Evolutions Fitness & Wellness Center",
			backgroundColor: "rgb(7, 71, 100)",
			foregroundColor: "rgb(255, 255, 255)",
			labelColor: "rgb(255, 255, 255)",
		},
	);

	pass.type = "storeCard";

	pass.primaryFields.push({
		key: "member-name",
		label: "MEMBER",
		value: member.name,
	});

	pass.headerFields.push({
		key: "membership-number",
		label: "MEMBERSHIP #",
		value: member.id,
	});

	const { status, hours } = getGymStatus();

	pass.secondaryFields.push({
		key: "gym-hours",
		label: status.toUpperCase(),
		value: hours,
	});

	pass.backFields.push(
		{
			key: "gym-name",
			label: "Gym",
			value: "Evolutions Fitness & Wellness Center",
		},
		{
			key: "member-id",
			label: "Member ID",
			value: member.id,
		},
		{
			key: "member-since",
			label: "Member Since",
			value: member.memberSince,
		},
	);

	pass.setBarcodes({
		message: member.id,
		format: "PKBarcodeFormatCode128",
		messageEncoding: "iso-8859-1",
		altText: member.id,
	});

	return new Response(pass.getAsBuffer(), {
		headers: {
			"Content-type": pass.mimeType,
			"Content-disposition": `attachment; filename=evolutions-membership.pkpass`,
		},
	});
}

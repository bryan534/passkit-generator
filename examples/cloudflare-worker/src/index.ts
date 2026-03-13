import { PKPass } from "passkit-generator";
import { Buffer } from "node:buffer";

import icon from "../../models/gymMembership.pass/icon.png";
import icon2x from "../../models/gymMembership.pass/icon@2x.png";
import logo from "../../models/gymMembership.pass/logo.png";
import logo2x from "../../models/gymMembership.pass/logo@2x.png";

const PASS_TYPE_ID = "pass.bvyan.com";
const TEAM_ID = "C2G8UXXA46";
const WORKER_URL = "https://pg-cw-example.bryan-contreras83.workers.dev";

export interface Env {
	WWDR: string;
	SIGNER_CERT: string;
	SIGNER_KEY: string;
	SIGNER_PASSPHRASE: string;
	ACCESS_TOKEN: string;
	PASS_AUTH_TOKEN: string; // ≥16 chars, embedded in pass for Apple to auth requests
	APNS_KEY: string;
	APNS_KEY_ID: string;
	ALLOWED_ORIGINS: string;
	PASS_REGISTRATIONS: KVNamespace;
	ASSETS: Fetcher;
}

// ── Rate limiter ────────────────────────────────────────────────────────────
const rateLimits = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const last = rateLimits.get(ip) ?? 0;
	if (now - last < RATE_LIMIT_MS) return true;
	rateLimits.set(ip, now);
	for (const [key, ts] of rateLimits) {
		if (now - ts >= RATE_LIMIT_MS) rateLimits.delete(key);
	}
	return false;
}

// ── Gym hours ───────────────────────────────────────────────────────────────
function getGymStatus(): { status: string; hours: string } {
	const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
	const day = now.getDay();
	const hour = now.getHours() + now.getMinutes() / 60;

	let open: number, close: number, hours: string;
	if (day >= 1 && day <= 4) {
		open = 4.5; close = 22; hours = "4:30am - 10:00pm";
	} else if (day === 5) {
		open = 4.5; close = 20; hours = "4:30am - 8:00pm";
	} else {
		open = 6; close = 18; hours = "6:00am - 6:00pm";
	}

	return { status: hour >= open && hour < close ? "Open" : "Closed", hours };
}

// ── CORS ────────────────────────────────────────────────────────────────────
function corsHeaders(origin: string) {
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

// ── APNs JWT ────────────────────────────────────────────────────────────────
async function sendApnsPush(env: Env, pushToken: string): Promise<void> {
	const keyBody = env.APNS_KEY
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s/g, "");

	const keyData = Uint8Array.from(atob(keyBody), c => c.charCodeAt(0));
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		keyData,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	const now = Math.floor(Date.now() / 1000);
	const encode = (obj: object) =>
		btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

	const message = `${encode({ alg: "ES256", kid: env.APNS_KEY_ID })}.${encode({ iss: TEAM_ID, iat: now })}`;
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		new TextEncoder().encode(message),
	);
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

	const jwt = `${message}.${sigB64}`;

	await fetch(`https://api.push.apple.com/3/device/${pushToken}`, {
		method: "POST",
		headers: {
			authorization: `bearer ${jwt}`,
			"apns-topic": PASS_TYPE_ID,
			"apns-push-type": "background",
			"content-type": "application/json",
		},
		body: "{}",
	});
}

// ── Auth helper ─────────────────────────────────────────────────────────────
function checkPassAuth(request: Request, env: Env): boolean {
	const auth = request.headers.get("Authorization") ?? "";
	return auth === `ApplePass ${env.PASS_AUTH_TOKEN}`;
}

// ── Member data types ────────────────────────────────────────────────────────
interface MemberData {
	name: string;
	id: string;
	memberSince: string;
}

// ── Main fetch handler ───────────────────────────────────────────────────────
export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { method, pathname } = { method: request.method, pathname: url.pathname };
		const origin = request.headers.get("Origin") ?? "";
		const allowedOrigins = env.ALLOWED_ORIGINS
			? env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
			: [];

		// ── CORS preflight ───────────────────────────────────────────────────
		if (method === "OPTIONS") {
			if (!allowedOrigins.includes(origin)) return new Response(null, { status: 204 });
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}

		// ── PassKit Web Service: register device ─────────────────────────────
		// POST /v1/devices/{deviceId}/registrations/{passTypeId}/{serialNumber}
		const regMatch = pathname.match(
			/^\/v1\/devices\/([^/]+)\/registrations\/([^/]+)\/([^/]+)$/,
		);
		if (regMatch) {
			const [, deviceId, passTypeId, serialNumber] = regMatch;
			if (passTypeId !== PASS_TYPE_ID) return new Response(null, { status: 404 });

			if (method === "POST") {
				if (!checkPassAuth(request, env)) return new Response(null, { status: 401 });
				const { pushToken } = await request.json<{ pushToken: string }>();
				const key = `reg:${deviceId}:${passTypeId}:${serialNumber}`;
				const existing = await env.PASS_REGISTRATIONS.get(key, { cacheTtl: 60 });
				await env.PASS_REGISTRATIONS.put(key, JSON.stringify({ pushToken, deviceId }));
				return new Response(null, { status: existing ? 200 : 201 });
			}

			if (method === "DELETE") {
				if (!checkPassAuth(request, env)) return new Response(null, { status: 401 });
				await env.PASS_REGISTRATIONS.delete(
					`reg:${deviceId}:${passTypeId}:${serialNumber}`,
				);
				return new Response(null, { status: 200 });
			}
		}

		// ── PassKit Web Service: list updated serials for device ─────────────
		// GET /v1/devices/{deviceId}/registrations/{passTypeId}
		const listMatch = pathname.match(/^\/v1\/devices\/([^/]+)\/registrations\/([^/]+)$/);
		if (listMatch && method === "GET") {
			const [, deviceId, passTypeId] = listMatch;
			if (passTypeId !== PASS_TYPE_ID) return new Response(null, { status: 404 });

			const prefix = `reg:${deviceId}:${passTypeId}:`;
			const listed = await env.PASS_REGISTRATIONS.list({ prefix });
			const serialNumbers = listed.keys.map(k => k.name.replace(prefix, ""));

			if (serialNumbers.length === 0) return new Response(null, { status: 204 });

			return Response.json({
				lastUpdated: String(Math.floor(Date.now() / 1000)),
				serialNumbers,
			});
		}

		// ── PassKit Web Service: serve updated pass ──────────────────────────
		// GET /v1/passes/{passTypeId}/{serialNumber}
		const passMatch = pathname.match(/^\/v1\/passes\/([^/]+)\/([^/]+)$/);
		if (passMatch && method === "GET") {
			const [, passTypeId, serialNumber] = passMatch;
			if (passTypeId !== PASS_TYPE_ID) return new Response(null, { status: 404 });
			if (!checkPassAuth(request, env)) return new Response(null, { status: 401 });

			const raw = await env.PASS_REGISTRATIONS.get(`member:${serialNumber}`, { cacheTtl: 300 });
			if (!raw) return new Response(null, { status: 404 });

			const member: MemberData = JSON.parse(raw);
			const passResponse = await generatePass(env, member);
			const headers = new Headers(passResponse.headers);
			headers.set("Last-Modified", new Date().toUTCString());
			return new Response(passResponse.body, { status: 200, headers });
		}

		// ── PassKit Web Service: log errors ──────────────────────────────────
		if (pathname === "/v1/log" && method === "POST") {
			return new Response(null, { status: 200 });
		}

		// ── GET /?token= — direct Safari link ────────────────────────────────
		if (method === "GET" && pathname === "/") {
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

		// ── POST /api/pass — frontend form ───────────────────────────────────
		if (method === "POST" && pathname === "/api/pass") {
			if (!allowedOrigins.includes(origin)) return new Response("Forbidden", { status: 403 });

			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			if (isRateLimited(ip)) {
				return new Response("Too many requests", { status: 429, headers: corsHeaders(origin) });
			}

			let member: MemberData;
			try {
				member = await request.json<MemberData>();
			} catch {
				return new Response("Bad request", { status: 400, headers: corsHeaders(origin) });
			}

			if (
				!member.name || member.name.length > 100 ||
				!member.id || !/^\d{5,12}$/.test(member.id) ||
				!member.memberSince || member.memberSince.length > 50
			) {
				return new Response("Bad request", { status: 400, headers: corsHeaders(origin) });
			}

			// Store member data so we can regenerate the pass on push updates
			await env.PASS_REGISTRATIONS.put(`member:${member.id}`, JSON.stringify(member));

			const passResponse = await generatePass(env, member);
			const headers = new Headers(passResponse.headers);
			for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
			return new Response(passResponse.body, { status: passResponse.status, headers });
		}

		return env.ASSETS.fetch(request);
	},

	// ── Cron: push update to all registered devices ──────────────────────────
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		const listed = await env.PASS_REGISTRATIONS.list({ prefix: "reg:" });
		const seen = new Set<string>();

		for (const entry of listed.keys) {
			const raw = await env.PASS_REGISTRATIONS.get(entry.name, { cacheTtl: 300 });
			if (!raw) continue;
			const { pushToken } = JSON.parse(raw) as { pushToken: string };
			if (seen.has(pushToken)) continue;
			seen.add(pushToken);
			await sendApnsPush(env, pushToken);
		}
	},
};

// ── Pass generation ──────────────────────────────────────────────────────────
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
			passTypeIdentifier: PASS_TYPE_ID,
			teamIdentifier: TEAM_ID,
			organizationName: "Evolutions Fitness & Wellness Center",
			backgroundColor: "rgb(7, 71, 100)",
			foregroundColor: "rgb(255, 255, 255)",
			labelColor: "rgb(255, 255, 255)",
			associatedStoreIdentifiers: [6689523412],
			appLaunchURL: "https://apps.apple.com/us/app/evolutions-fitness-wellness/id6689523412",
			webServiceURL: WORKER_URL,
			authenticationToken: env.PASS_AUTH_TOKEN,
		},
	);

	pass.type = "storeCard";

	pass.headerFields.push({
		key: "membership-number",
		label: "MEMBERSHIP #",
		value: member.id,
	});

	pass.primaryFields.push({
		key: "member-name",
		label: "MEMBER",
		value: member.name,
	});

	const { status, hours } = getGymStatus();
	pass.secondaryFields.push({
		key: "gym-hours",
		label: status.toUpperCase(),
		value: hours,
	});

	pass.backFields.push(
		{ key: "gym-name", label: "Gym", value: "Evolutions Fitness & Wellness Center" },
		{ key: "member-id", label: "Member ID", value: member.id },
		{ key: "member-since", label: "Member Since", value: member.memberSince },
		{
			key: "gym-phone",
			label: "Phone",
			value: "tel:+15596853800",
			attributedValue: "<a href='tel:+15596853800'>(559) 685-3800</a>",
		},
		{
			key: "gym-website",
			label: "Website",
			value: "https://www.evolutionstulare.com",
			attributedValue: "<a href='https://www.evolutionstulare.com'>evolutionstulare.com</a>",
		},
		{ key: "gym-address", label: "Address", value: "1425 E Prosperity Ave\nTulare, CA 93274" },
	);

	pass.setBarcodes({
		message: member.id,
		format: "PKBarcodeFormatQR",
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

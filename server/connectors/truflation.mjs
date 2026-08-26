import {
  ConnectorDisabledError,
  ConnectorRequestError,
  ConnectorValidationError,
  createContentHash,
  createHealthReport,
  createObservation,
} from "./contracts.mjs";

export const TRUFLATION_US_INFLATION_URL =
  "https://truflation.com/marketplace/us-inflation-rate";

function dateOnly(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConnectorValidationError(`${field} must use YYYY-MM-DD`, { field });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ConnectorValidationError(`${field} is not a valid calendar date`, { field });
  }
  return parsed;
}

function officialSourceUrl(value = TRUFLATION_US_INFLATION_URL) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConnectorValidationError("source_url must be a valid Truflation URL", {
      field: "source_url",
    });
  }
  if (
    parsed.protocol !== "https:" ||
    !(
      parsed.hostname.toLocaleLowerCase("en-US") === "truflation.com" ||
      parsed.hostname.toLocaleLowerCase("en-US").endsWith(".truflation.com")
    )
  ) {
    throw new ConnectorValidationError("source_url must be on truflation.com over HTTPS", {
      field: "source_url",
    });
  }
  return parsed.toString();
}

export function validateTruflationManualObservation(
  input,
  { clock = () => new Date() } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorValidationError("Truflation observation must be an object", {
      field: "observation",
    });
  }
  const userConfirmed = input.user_confirmed === true || input.confirmed_by_user === true;
  if (!userConfirmed) {
    throw new ConnectorValidationError("A manual Truflation value requires user confirmation", {
      field: "user_confirmed",
    });
  }
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < -100 || value > 1_000) {
    throw new ConnectorValidationError("value must be a finite percentage between -100 and 1000", {
      field: "value",
    });
  }
  const asOfInput = input.as_of ?? input.observation_date;
  const asOfDate = dateOnly(
    typeof asOfInput === "string" ? asOfInput.slice(0, 10) : asOfInput,
    "as_of",
  );
  const observedAt = input.retrieved_at ? new Date(input.retrieved_at) : clock();
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  if (asOfDate.getTime() > observedAt.getTime() + 86_400_000) {
    throw new ConnectorValidationError("as_of cannot be more than one day in the future", {
      field: "as_of",
    });
  }
  if (input.unit != null && input.unit !== "percent_yoy") {
    throw new ConnectorValidationError("unit must be percent_yoy", { field: "unit" });
  }
  const suppliedSeries = input.series ?? input.series_id;
  if (suppliedSeries != null && !["us_inflation_rate", "TruCPI-US"].includes(suppliedSeries)) {
    throw new ConnectorValidationError("series must identify the Truflation U.S. inflation rate", {
      field: "series",
    });
  }
  const note = input.note == null ? undefined : String(input.note).trim().slice(0, 2_000);
  const sourceUrl = officialSourceUrl(input.source_url);
  const asOf = asOfDate.toISOString();
  const observedAtIso = observedAt.toISOString();

  return Object.freeze({
    series: "us_inflation_rate",
    value,
    unit: "percent_yoy",
    as_of: asOf,
    observed_at: observedAtIso,
    source_url: sourceUrl,
    note,
    user_confirmed: true,
  });
}

function manualToObservation(manual) {
  return createObservation({
    external_event_id: `truflation:us_inflation_rate:${manual.as_of.slice(0, 10)}`,
    feed_id: "truflation.us-inflation.manual",
    observed_at: manual.observed_at,
    as_of: manual.as_of,
    content_hash: createContentHash(manual),
    source_url: manual.source_url,
    evidence_status: "manual_snapshot",
    matched_interest_ids: ["us-inflation"],
    materiality: "unscored",
    coverage_state: "partial",
    license_ref: "manual_reference_only_no_redistribution",
    title: `Truflation U.S. inflation — ${manual.as_of.slice(0, 10)}`,
    summary: `${manual.value}% year over year${manual.note ? ` — ${manual.note}` : ""}`,
    payload: {
      series: manual.series,
      value: manual.value,
      unit: manual.unit,
      capture_method: "manual_snapshot",
      alternative_inflation_estimate: true,
      not_official_cpi: true,
      may_trigger_mission_alone: false,
      may_enter_audio: false,
      may_export_to_team: false,
    },
    untrusted_external_content: true,
  });
}

function authorizedLicense(license) {
  return Boolean(
    license?.license_ref &&
      license?.allow_local_storage === true &&
      license?.allow_ai_derivatives === true,
  );
}

function parseLicensedValue(body, clock) {
  const candidate = body?.data ?? body;
  const value = Number(candidate?.value ?? candidate?.rate ?? candidate?.inflation_rate);
  const asOfRaw = candidate?.as_of ?? candidate?.date ?? candidate?.timestamp;
  if (!Number.isFinite(value) || !asOfRaw || !Number.isFinite(Date.parse(asOfRaw))) {
    throw new ConnectorRequestError("Licensed Truflation API returned an unsupported payload", {
      code: "truflation_invalid_response",
    });
  }
  const asOf = new Date(asOfRaw).toISOString();
  const observedAt = clock().toISOString();
  return { value, asOf, observedAt };
}

export function createTruflationConnector({
  apiEnabled = false,
  apiEndpoint,
  apiKeyStore,
  apiKeyName = "truflation-api-key",
  license,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  const apiAuthorized = apiEnabled && authorizedLicense(license) && Boolean(apiEndpoint);
  let lastHealth = Object.freeze({
    ...createHealthReport({
      feedId: "truflation.us-inflation",
      state: "healthy",
      checkedAt: clock().toISOString(),
      coverageState: "partial",
      message: apiAuthorized
        ? "Licensed API configured; manual snapshot remains available"
        : "Manual snapshot only; licensed API is disabled",
    }),
    mode: apiAuthorized ? "licensed_api" : "manual_only",
    api_state: apiAuthorized ? "configured" : "disabled",
    scrape_fallback: false,
    export_allowed: Boolean(license?.allow_redistribution),
    audio_allowed: Boolean(license?.allow_audio),
  });

  return Object.freeze({
    manualObservation(input) {
      return manualToObservation(validateTruflationManualObservation(input, { clock }));
    },
    getHealth() {
      return lastHealth;
    },
    async pollApi() {
      const checkedAt = clock().toISOString();
      if (!apiEnabled) {
        throw new ConnectorDisabledError("Truflation API feature flag is off", {
          code: "truflation_api_disabled",
        });
      }
      if (!authorizedLicense(license)) {
        throw new ConnectorDisabledError("Truflation Data License has not authorized local AI use", {
          code: "truflation_license_required",
        });
      }
      if (!apiEndpoint) {
        throw new ConnectorDisabledError("No official Truflation API endpoint is configured", {
          code: "truflation_endpoint_required",
        });
      }
      const validatedApiEndpoint = officialSourceUrl(apiEndpoint);
      if (!apiKeyStore?.read || typeof fetchImpl !== "function") {
        throw new ConnectorDisabledError("Truflation API key storage is unavailable", {
          code: "truflation_api_key_store_required",
        });
      }
      const apiKey = await apiKeyStore.read(apiKeyName);
      if (!apiKey) {
        throw new ConnectorDisabledError("Truflation API key is unavailable", {
          code: "truflation_api_key_required",
        });
      }

      let response;
      try {
        response = await fetchImpl(validatedApiEndpoint, {
          method: "GET",
          headers: { accept: "application/json", "x-api-key": apiKey },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        lastHealth = Object.freeze({
          ...createHealthReport({
            feedId: "truflation.us-inflation",
            state: "error",
            checkedAt,
            coverageState: "unknown",
            message: "Licensed Truflation API request failed",
          }),
          mode: "licensed_api",
          scrape_fallback: false,
        });
        return { ok: false, error: { code: "truflation_network_error" }, health: lastHealth };
      }

      if (!response.ok) {
        const failClosed = [401, 403, 429].includes(response.status);
        lastHealth = Object.freeze({
          ...createHealthReport({
            feedId: "truflation.us-inflation",
            state: failClosed ? "disabled" : "error",
            checkedAt,
            coverageState: "unknown",
            message: `Licensed Truflation API returned HTTP ${response.status}; scrape fallback remains off`,
          }),
          mode: "licensed_api",
          api_state: failClosed ? "fail_closed" : "error",
          scrape_fallback: false,
        });
        return {
          ok: false,
          error: { code: failClosed ? "truflation_api_fail_closed" : "truflation_api_error" },
          health: lastHealth,
        };
      }

      try {
        const licensed = parseLicensedValue(await response.json(), clock);
        const observation = createObservation({
          external_event_id: `truflation:us_inflation_rate:${licensed.asOf}`,
          feed_id: "truflation.us-inflation.api",
          observed_at: licensed.observedAt,
          as_of: licensed.asOf,
          source_url: validatedApiEndpoint,
          evidence_status: "unverified_external",
          matched_interest_ids: ["us-inflation"],
          materiality: "unscored",
          coverage_state: "complete",
          license_ref: String(license.license_ref),
          title: "Licensed Truflation U.S. inflation observation",
          summary: `${licensed.value}% year over year`,
          payload: {
            value: licensed.value,
            unit: "percent_yoy",
            alternative_inflation_estimate: true,
            not_official_cpi: true,
            may_trigger_mission_alone: false,
            may_enter_audio: license.allow_audio === true,
            may_export_to_team: license.allow_redistribution === true,
          },
          untrusted_external_content: true,
        });
        lastHealth = Object.freeze({
          ...createHealthReport({
            feedId: "truflation.us-inflation",
            state: "healthy",
            checkedAt,
            coverageState: "complete",
            lastSuccessAt: checkedAt,
            message: "Licensed Truflation observation received",
          }),
          mode: "licensed_api",
          api_state: "healthy",
          scrape_fallback: false,
        });
        return { ok: true, observation, health: lastHealth };
      } catch (error) {
        lastHealth = Object.freeze({
          ...createHealthReport({
            feedId: "truflation.us-inflation",
            state: "error",
            checkedAt,
            coverageState: "unknown",
            message: "Licensed Truflation API payload was rejected",
          }),
          mode: "licensed_api",
          api_state: "error",
          scrape_fallback: false,
        });
        return {
          ok: false,
          error: { code: error?.code ?? "truflation_invalid_response" },
          health: lastHealth,
        };
      }
    },
  });
}

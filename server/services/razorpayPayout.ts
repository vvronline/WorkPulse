import { decrypt } from "../utils/encryption";
import { logger } from "../utils/logger";
import type { DbContext } from "../types/domain";

const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";

interface CreateContactOpts {
    name: string;
    email?: string;
    phone?: string;
    type?: string;
    referenceId?: string;
}

interface CreateFundAccountOpts {
    accountNumber: string;
    ifsc: string;
    name: string;
    accountType?: string;
}

interface ValidateFundAccountOpts {
    name?: string;
    phone?: string;
    accountNumber?: string;
    ifsc?: string;
}

interface CreatePayoutOpts {
    fundAccountId: string;
    amount: number;
    currency?: string;
    mode?: string;
    purpose?: string;
    referenceId?: string;
    narration?: string;
}

interface RazorpayErrorResponse {
    error?: { description?: string };
    [key: string]: unknown;
}

interface PaymentConfigRow {
    api_key_id: string;
    api_key_secret: string;
    account_number: string;
    [key: string]: unknown;
}

class RazorpayPayoutService {
    keyId: string;
    keySecret: string;
    accountNumber: string;
    authHeader: string;

    constructor(keyId: string, keySecret: string, accountNumber: string) {
        this.keyId = keyId;
        this.keySecret = keySecret;
        this.accountNumber = accountNumber;
        this.authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    }

    async _request(method: string, path: string, body: unknown = null): Promise<any> {
        const url = `${RAZORPAY_BASE_URL}${path}`;
        const headers: Record<string, string> = {
            "Authorization": this.authHeader,
            "Content-Type": "application/json",
        };
        const options: RequestInit = { method, headers };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const data = (await response.json()) as RazorpayErrorResponse;
        if (!response.ok) {
            const errMsg = data?.error?.description || JSON.stringify(data);
            logger.error({ status: response.status, data }, `Razorpay API error: ${path}`);
            throw new Error(`Razorpay API error (${response.status}): ${errMsg}`);
        }
        return data;
    }

    async createContact({ name, email, phone, type = "employee", referenceId }: CreateContactOpts): Promise<any> {
        return this._request("POST", "/contacts", {
            name,
            email,
            contact: phone || undefined,
            type,
            reference_id: referenceId,
        });
    }

    async createFundAccount(contactId: string, { accountNumber, ifsc, name }: CreateFundAccountOpts): Promise<any> {
        return this._request("POST", "/fund_accounts", {
            contact_id: contactId,
            account_type: "bank_account",
            bank_account: {
                name,
                ifsc,
                account_number: accountNumber,
            },
        });
    }

    async validateFundAccount(fundAccountId: string, _opts: ValidateFundAccountOpts): Promise<any> {
        return this._request("POST", "/fund_accounts/validations", {
            account_number: this.accountNumber,
            fund_account: {
                id: fundAccountId,
            },
            amount: 100,
            currency: "INR",
            notes: { purpose: "penny_drop_validation" },
        });
    }

    async createPayout({ fundAccountId, amount, currency = "INR", mode = "NEFT", purpose = "salary", referenceId, narration }: CreatePayoutOpts): Promise<any> {
        return this._request("POST", "/payouts", {
            account_number: this.accountNumber,
            fund_account_id: fundAccountId,
            amount: Math.round(amount * 100),
            currency,
            mode,
            purpose,
            queue_if_low_balance: true,
            reference_id: referenceId,
            narration: narration || `Salary ${referenceId}`,
        });
    }

    async getPayout(payoutId: string): Promise<any> {
        return this._request("GET", `/payouts/${payoutId}`);
    }

    async testConnection(): Promise<{ success: boolean; balance: unknown }> {
        const response = await fetch(`${RAZORPAY_BASE_URL}/balance?account_number=${this.accountNumber}`, {
            headers: { "Authorization": this.authHeader },
        });
        if (!response.ok) {
            const data = (await response.json()) as RazorpayErrorResponse;
            throw new Error(data?.error?.description || "Connection failed");
        }
        return { success: true, balance: ((await response.json()) as { balance: unknown }).balance };
    }
}

async function getPayoutService(db: DbContext, orgId: number): Promise<RazorpayPayoutService> {
    const config = (await db.query(
        `SELECT * FROM org_payment_config WHERE org_id = $1 AND is_active = TRUE`,
        [orgId],
    )).rows[0] as PaymentConfigRow | undefined;
    if (!config) throw new Error("Payment configuration not found or disabled");
    const keyId = decrypt(config.api_key_id);
    const keySecret = decrypt(config.api_key_secret);
    if (!keyId || !keySecret || !config.account_number) {
        throw new Error("Incomplete payment configuration");
    }
    return new RazorpayPayoutService(keyId, keySecret, config.account_number);
}

export { RazorpayPayoutService, getPayoutService };
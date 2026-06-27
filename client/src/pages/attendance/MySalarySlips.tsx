import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  CheckCircle,
  Clock,
  XCircle,
  CreditCard,
  Building2,
  Edit3,
  Save,
} from "lucide-react";
import {
  getMySalarySlips,
  downloadMySalarySlipPdf,
  getMyBankDetails,
  saveMyBankDetails,
} from "../../api";

const STATUS_ICONS: Record<string, React.ReactNode> = {
  processed: <CheckCircle size={14} style={{ color: "#10b981" }} />,
  processing: <Clock size={14} style={{ color: "#3b82f6" }} />,
  failed: <XCircle size={14} style={{ color: "#ef4444" }} />,
  reversed: <XCircle size={14} style={{ color: "#ef4444" }} />,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

interface BankForm {
  account_holder_name: string;
  account_number: string;
  ifsc_code: string;
  bank_name: string;
  account_type: string;
}

const EMPTY_SLIPS: any[] = [];

export default function MySalarySlips() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bankForm, setBankForm] = useState<BankForm>({
    account_holder_name: "",
    account_number: "",
    ifsc_code: "",
    bank_name: "",
    account_type: "savings",
  });

  const { data, isLoading: loading } = useQuery({
    queryKey: ["salary-slips", "mine"],
    queryFn: async () => {
      const [slipsRes, bankRes] = await Promise.all([
        getMySalarySlips(),
        getMyBankDetails(),
      ]);
      return { slips: slipsRes.data || [], bankDetails: bankRes.data };
    },
  });
  const slips: any[] = data?.slips ?? EMPTY_SLIPS;
  const bankDetails = data?.bankDetails ?? null;

  useEffect(() => {
    if (bankDetails) {
      setBankForm({
        account_holder_name: bankDetails.account_holder_name || "",
        account_number: "",
        ifsc_code: bankDetails.ifsc_code || "",
        bank_name: bankDetails.bank_name || "",
        account_type: bankDetails.account_type || "savings",
      });
    }
  }, [bankDetails]);

  const handleDownload = async (id: number | string, month: string) => {
    try {
      const res = await downloadMySalarySlipPdf(id as any);
      const url = window.URL.createObjectURL(new Blob([res.data as any]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `salary_slip_${month}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      alert("Failed to download PDF");
    }
  };

  const handleSaveBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !bankForm.account_holder_name ||
      !bankForm.account_number ||
      !bankForm.ifsc_code
    ) {
      alert("Please fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      await saveMyBankDetails(bankForm);
      await queryClient.invalidateQueries({
        queryKey: ["salary-slips", "mine"],
      });
      setEditing(false);
      setBankForm({
        account_holder_name: "",
        account_number: "",
        ifsc_code: "",
        bank_name: "",
        account_type: "savings",
      });
    } catch {
      alert("Failed to save bank details");
    }
    setSaving(false);
  };

  if (loading)
    return (
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        Loading salary slips...
      </div>
    );

  return (
    <div style={{ padding: "16px 0" }}>
      <h3
        style={{
          margin: "0 0 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--text)",
        }}
      >
        <CreditCard size={18} /> My Salary Slips
      </h3>

      {/* Bank Details Section */}
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "16px 20px",
          marginBottom: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: bankDetails && !editing ? 0 : 12,
          }}
        >
          <h4
            style={{
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
              color: "var(--text)",
            }}
          >
            <Building2 size={16} /> Bank Details
          </h4>
          {bankDetails && !editing && (
            <button
              onClick={() => {
                setBankForm({
                  account_holder_name: bankDetails.account_holder_name || "",
                  account_number: "",
                  ifsc_code: bankDetails.ifsc_code || "",
                  bank_name: bankDetails.bank_name || "",
                  account_type: bankDetails.account_type || "savings",
                });
                setEditing(true);
              }}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 10px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              <Edit3 size={12} /> Edit
            </button>
          )}
        </div>

        {bankDetails && !editing ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginTop: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 2,
                }}
              >
                Account Holder
              </div>
              <div
                style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}
              >
                {bankDetails.account_holder_name || "-"}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 2,
                }}
              >
                Account Number
              </div>
              <div
                style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}
              >
                {bankDetails.account_number}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 2,
                }}
              >
                IFSC Code
              </div>
              <div
                style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}
              >
                {bankDetails.ifsc_code}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 2,
                }}
              >
                Bank Name
              </div>
              <div
                style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}
              >
                {bankDetails.bank_name || "-"}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 2,
                }}
              >
                Status
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: bankDetails.is_verified
                    ? "var(--success)"
                    : "var(--warning)",
                }}
              >
                {bankDetails.is_verified
                  ? "✓ Verified"
                  : "Pending Verification"}
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSaveBank}>
            {!bankDetails && (
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  margin: "0 0 12px",
                }}
              >
                Add your bank details to receive salary payouts directly to your
                account.
              </p>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 12,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    display: "block",
                  }}
                >
                  Account Holder Name *
                </label>
                <input
                  style={inputStyle}
                  value={bankForm.account_holder_name}
                  onChange={(e) =>
                    setBankForm((f) => ({
                      ...f,
                      account_holder_name: e.target.value,
                    }))
                  }
                  placeholder="Full name as per bank"
                  required
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    display: "block",
                  }}
                >
                  Account Number *
                </label>
                <input
                  style={inputStyle}
                  value={bankForm.account_number}
                  onChange={(e) =>
                    setBankForm((f) => ({
                      ...f,
                      account_number: e.target.value,
                    }))
                  }
                  placeholder="Enter account number"
                  required
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    display: "block",
                  }}
                >
                  IFSC Code *
                </label>
                <input
                  style={inputStyle}
                  value={bankForm.ifsc_code}
                  onChange={(e) =>
                    setBankForm((f) => ({
                      ...f,
                      ifsc_code: e.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="e.g. SBIN0001234"
                  required
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    display: "block",
                  }}
                >
                  Bank Name
                </label>
                <input
                  style={inputStyle}
                  value={bankForm.bank_name}
                  onChange={(e) =>
                    setBankForm((f) => ({ ...f, bank_name: e.target.value }))
                  }
                  placeholder="e.g. State Bank of India"
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    display: "block",
                  }}
                >
                  Account Type
                </label>
                <select
                  style={inputStyle}
                  value={bankForm.account_type}
                  onChange={(e) =>
                    setBankForm((f) => ({ ...f, account_type: e.target.value }))
                  }
                >
                  <option value="savings">Savings</option>
                  <option value="current">Current</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                type="submit"
                disabled={saving}
                style={{
                  background: "var(--primary)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 16px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  opacity: saving ? 0.7 : 1,
                }}
              >
                <Save size={14} /> {saving ? "Saving..." : "Save Bank Details"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  style={{
                    background: "var(--surface)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "8px 16px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {/* Salary Slips Table */}
      {slips.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: 40,
            color: "var(--text-muted)",
          }}
        >
          No salary slips available yet.
        </div>
      ) : (
        <div
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow)",
            overflow: "hidden",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              color: "var(--text)",
            }}
          >
            <thead>
              <tr
                style={{
                  background: "var(--bg-elevated)",
                  borderBottom: "1px solid var(--border)",
                  textAlign: "left",
                }}
              >
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Month
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Gross
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Deductions
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Net Pay
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Payment
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {slips.map((slip, idx) => (
                <tr
                  key={slip.id}
                  style={{
                    borderBottom:
                      idx < slips.length - 1
                        ? "1px solid var(--border)"
                        : "none",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--surface-hover)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <td style={{ padding: "12px 16px", fontWeight: 600 }}>
                    {slip.slip_month}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    ₹{Number(slip.gross_earnings).toLocaleString("en-IN")}
                  </td>
                  <td style={{ padding: "12px 16px", color: "var(--danger)" }}>
                    ₹{Number(slip.total_deductions).toLocaleString("en-IN")}
                  </td>
                  <td style={{ padding: "12px 16px", fontWeight: 700 }}>
                    ₹{Number(slip.net_pay).toLocaleString("en-IN")}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    {slip.disbursement_status ? (
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {STATUS_ICONS[slip.disbursement_status] || (
                          <Clock size={14} />
                        )}
                        {slip.disbursement_status === "processed"
                          ? "Paid"
                          : slip.disbursement_status}
                        {slip.utr && (
                          <small
                            style={{
                              color: "var(--text-muted)",
                              marginLeft: 4,
                            }}
                          >
                            UTR: {slip.utr}
                          </small>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>
                        Pending
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <button
                      onClick={() => handleDownload(slip.id, slip.slip_month)}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 12,
                        color: "var(--text)",
                      }}
                      title="Download PDF"
                    >
                      <Download size={13} /> PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

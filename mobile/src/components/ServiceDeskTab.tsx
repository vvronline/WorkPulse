import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Bug,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { useDialog } from "../hooks/useDialog";
import { useAuth } from "../auth/AuthContext";
import {
  createServiceDeskTicket,
  deleteServiceDeskTicket,
  getServiceDeskStats,
  getServiceDeskTickets,
  type ServiceDeskStats,
  type ServiceDeskTicket,
} from "../features";

const TICKET_TYPES = [
  { value: "bug", label: "Bug Report", color: "#ef4444", Icon: Bug },
  { value: "feature_request", label: "Feature Request", color: "#8b5cf6", Icon: Sparkles },
  { value: "access_issue", label: "Access Issue", color: "#f59e0b", Icon: ShieldAlert },
  { value: "other", label: "Other", color: "#6b7280", Icon: HelpCircle },
];

const PRIORITIES = [
  { value: "low", label: "Low", color: "#22c55e" },
  { value: "medium", label: "Medium", color: "#f59e0b" },
  { value: "high", label: "High", color: "#ef4444" },
  { value: "critical", label: "Critical", color: "#dc2626" },
];

const STATUSES = [
  { value: "open", label: "Open", color: "#3b82f6" },
  { value: "acknowledged", label: "Acknowledged", color: "#8b5cf6" },
  { value: "in_progress", label: "In Progress", color: "#f59e0b" },
  { value: "resolved", label: "Resolved", color: "#22c55e" },
  { value: "closed", label: "Closed", color: "#6b7280" },
];

function getType(value: string) {
  return TICKET_TYPES.find((t) => t.value === value) || TICKET_TYPES[3];
}
function getPriority(value: string) {
  return PRIORITIES.find((p) => p.value === value) || PRIORITIES[1];
}
function getStatus(value: string) {
  return STATUSES.find((s) => s.value === value) || STATUSES[0];
}

export default function ServiceDeskTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, confirm, dialog } = useDialog();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<ServiceDeskTicket[]>([]);
  const [stats, setStats] = useState<ServiceDeskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterStatus) params.status = filterStatus;
      if (filterType) params.ticket_type = filterType;
      const res = await getServiceDeskTickets(params);
      setTickets(res.data.tickets || []);
    } catch {
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterType]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await getServiceDeskStats();
      setStats(res.data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchTickets();
    fetchStats();
  }, [fetchTickets, fetchStats]);

  function confirmDelete(ticket: ServiceDeskTicket) {
    const isOwn = ticket.submitted_by_user_id === user?.id;
    const isCancel = isOwn && ticket.status === "open";
    const msg = isCancel
      ? `Cancel ticket "${ticket.title}"? This also removes it from the platform team's backlog.`
      : `Delete ticket "${ticket.title}"? This cannot be undone.`;
    confirm({
      title: isCancel ? "Cancel Ticket" : "Delete Ticket",
      message: msg,
      confirmText: isCancel ? "Cancel Ticket" : "Delete",
      cancelText: "Keep",
      isDanger: true,
      onConfirm: async () => {
        setDeletingId(ticket.id);
        try {
          await deleteServiceDeskTicket(ticket.id);
          setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
          fetchStats();
        } catch (e: any) {
          alert("Error", e?.response?.data?.error || "Failed to delete ticket");
        } finally {
          setDeletingId(null);
        }
      },
    });
  }

  return (
    <View style={styles.wrap}>
      {/* Stats bar */}
      {stats ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.statsBar}
        >
          <Pressable
            style={[styles.statChip, !filterStatus && styles.statChipActive]}
            onPress={() => setFilterStatus("")}
          >
            <Text style={styles.statValue}>{stats.total}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </Pressable>
          {STATUSES.filter(
            (st) => (stats as any)[st.value] > 0 || st.value === "open",
          ).map((st) => (
            <Pressable
              key={st.value}
              style={[
                styles.statChip,
                filterStatus === st.value && styles.statChipActive,
                filterStatus === st.value && { borderColor: st.color },
              ]}
              onPress={() =>
                setFilterStatus((prev) => (prev === st.value ? "" : st.value))
              }
            >
              <Text style={[styles.statValue, { color: st.color }]}>
                {(stats as any)[st.value] || 0}
              </Text>
              <Text style={styles.statLabel}>{st.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {/* Type filter + New button */}
      <View style={styles.toolbar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.typeFilterRow}
        >
          <Pressable
            style={[styles.typeChip, !filterType && styles.typeChipActive]}
            onPress={() => setFilterType("")}
          >
            <Text style={[styles.typeChipText, !filterType && styles.typeChipTextActive]}>
              All
            </Text>
          </Pressable>
          {TICKET_TYPES.map((t) => {
            const active = filterType === t.value;
            return (
              <Pressable
                key={t.value}
                style={[styles.typeChip, active && styles.typeChipActive]}
                onPress={() => setFilterType((prev) => (prev === t.value ? "" : t.value))}
              >
                <t.Icon size={13} color={active ? "#fff" : t.color} />
                <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <Pressable style={styles.newBtn} onPress={() => setFormOpen(true)}>
        <Plus size={16} color="#fff" />
        <Text style={styles.newBtnText}>New Ticket</Text>
      </Pressable>

      {/* Tickets */}
      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginVertical: 24 }} />
      ) : tickets.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🎫</Text>
          <Text style={styles.emptyText}>No tickets found</Text>
          <Text style={styles.emptySub}>
            Submit a ticket to report bugs, request features, or get help.
          </Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {tickets.map((ticket) => {
            const type = getType(ticket.ticket_type);
            const pri = getPriority(ticket.priority);
            const st = getStatus(ticket.status);
            const isExpanded = expanded === ticket.id;
            const isOwner = ticket.submitted_by_user_id === user?.id;
            const canDelete = isOwner && ticket.status === "open";
            return (
              <View key={ticket.id} style={styles.ticketCard}>
                <Pressable
                  style={styles.ticketHeader}
                  onPress={() => setExpanded(isExpanded ? null : ticket.id)}
                >
                  <View style={styles.ticketLeft}>
                    <View style={styles.typeRow}>
                      <type.Icon size={13} color={type.color} />
                      <Text style={[styles.typeLabel, { color: type.color }]}>
                        {type.label}
                      </Text>
                    </View>
                    <Text style={styles.ticketTitle} numberOfLines={2}>
                      {ticket.title}
                    </Text>
                  </View>
                  {isExpanded ? (
                    <ChevronUp size={18} color={theme.textSecondary} />
                  ) : (
                    <ChevronDown size={18} color={theme.textSecondary} />
                  )}
                </Pressable>
                <View style={styles.ticketMetaRow}>
                  <Text style={[styles.ticketPriority, { color: pri.color }]}>
                    {pri.label}
                  </Text>
                  <View style={[styles.statusBadge, { borderColor: st.color }]}>
                    <Text style={[styles.statusBadgeText, { color: st.color }]}>
                      {st.label}
                    </Text>
                  </View>
                  <Text style={styles.ticketDate}>
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </Text>
                  {canDelete ? (
                    <Pressable
                      onPress={() => confirmDelete(ticket)}
                      hitSlop={8}
                      disabled={deletingId === ticket.id}
                    >
                      <Trash2 size={15} color={theme.danger} />
                    </Pressable>
                  ) : null}
                </View>
                {isExpanded ? (
                  <View style={styles.ticketDetails}>
                    {ticket.description ? (
                      <Text style={styles.ticketDesc}>{ticket.description}</Text>
                    ) : null}
                    <Text style={styles.metaLine}>
                      Submitted by:{" "}
                      <Text style={styles.metaStrong}>{ticket.submitted_by_name}</Text>
                    </Text>
                    {ticket.tenant_name ? (
                      <Text style={styles.metaLine}>
                        Organization:{" "}
                        <Text style={styles.metaStrong}>{ticket.tenant_name}</Text>
                      </Text>
                    ) : null}
                    {ticket.admin_notes ? (
                      <Text style={styles.metaLine}>
                        Admin Notes:{" "}
                        <Text style={styles.metaStrong}>{ticket.admin_notes}</Text>
                      </Text>
                    ) : null}
                    {ticket.resolved_at ? (
                      <Text style={styles.metaLine}>
                        Resolved:{" "}
                        {new Date(ticket.resolved_at).toLocaleDateString()}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      <NewTicketModal
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={() => {
          setFormOpen(false);
          fetchTickets();
          fetchStats();
        }}
      />

      {/* Themed confirm / alert dialog (replaces OS-native Alert). */}
      {dialog}
    </View>
  );
}

function NewTicketModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, dialog } = useDialog();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ticketType, setTicketType] = useState("bug");
  const [priority, setPriority] = useState("medium");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle("");
      setDescription("");
      setTicketType("bug");
      setPriority("medium");
    }
  }, [visible]);

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await createServiceDeskTicket({
        title: title.trim(),
        description: description.trim(),
        ticket_type: ticketType,
        priority,
      });
      onCreated();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to submit ticket");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {dialog}
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>New Service Desk Ticket</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ gap: 6 }}>
            <Text style={styles.label}>Title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Ticket title..."
              placeholderTextColor={theme.textMuted}
              maxLength={200}
            />

            <Text style={styles.label}>Details</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={description}
              onChangeText={setDescription}
              placeholder="Steps to reproduce, expected behavior, etc."
              placeholderTextColor={theme.textMuted}
              multiline
            />

            <Text style={styles.label}>Type</Text>
            <View style={styles.chipRow}>
              {TICKET_TYPES.map((t) => {
                const active = ticketType === t.value;
                return (
                  <Pressable
                    key={t.value}
                    style={[styles.selChip, active && styles.selChipActive]}
                    onPress={() => setTicketType(t.value)}
                  >
                    <t.Icon size={13} color={active ? "#fff" : t.color} />
                    <Text style={[styles.selChipText, active && styles.selChipTextActive]}>
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>Priority</Text>
            <View style={styles.chipRow}>
              {PRIORITIES.map((p) => {
                const active = priority === p.value;
                return (
                  <Pressable
                    key={p.value}
                    style={[
                      styles.selChip,
                      active && { backgroundColor: p.color, borderColor: p.color },
                    ]}
                    onPress={() => setPriority(p.value)}
                  >
                    <Text style={[styles.selChipText, active && styles.selChipTextActive]}>
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              style={[styles.submit, (submitting || !title.trim()) && styles.disabled]}
              onPress={submit}
              disabled={submitting || !title.trim()}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>Create Ticket</Text>
              )}
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  wrap: { gap: 12 },
  statsBar: { gap: 8, paddingVertical: 2 },
  statChip: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
    minWidth: 64,
  },
  statChipActive: { backgroundColor: theme.surfaceHover, borderColor: theme.primary },
  statValue: { fontSize: 18, fontWeight: "800", color: theme.text },
  statLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  toolbar: { flexDirection: "row" },
  typeFilterRow: { gap: 8 },
  typeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  typeChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  typeChipText: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
  typeChipTextActive: { color: "#fff", fontWeight: "600" },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
  },
  newBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  empty: { alignItems: "center", gap: 8, paddingTop: 48, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 36 },
  emptyText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  emptySub: { color: theme.textMuted, fontSize: 13, textAlign: "center" },
  ticketCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 8,
  },
  ticketHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  ticketLeft: { flex: 1, gap: 4 },
  typeRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  typeLabel: { fontSize: 11, fontWeight: "700" },
  ticketTitle: { fontSize: 15, fontWeight: "600", color: theme.text, lineHeight: 20 },
  ticketMetaRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  ticketPriority: { fontSize: 12, fontWeight: "700" },
  statusBadge: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusBadgeText: { fontSize: 11, fontWeight: "600" },
  ticketDate: { fontSize: 11, color: theme.textMuted, flex: 1 },
  ticketDetails: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: 10,
    gap: 6,
  },
  ticketDesc: { fontSize: 13, color: theme.text, lineHeight: 19 },
  metaLine: { fontSize: 12, color: theme.textSecondary },
  metaStrong: { color: theme.text, fontWeight: "600" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.text },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
  },
  textArea: { minHeight: 90, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  selChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  selChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  selChipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  selChipTextActive: { color: "#fff", fontWeight: "600" },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
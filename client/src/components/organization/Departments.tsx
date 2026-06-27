import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import {
  getOrgDepartments,
  getOrgMembers,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from "../../api";
import s from "../../pages/Admin.module.css";
import su from "../../pages/admin/AdminUtils.module.css";

interface DepartmentRow {
  id: number | string;
  name: string;
  head_id?: number | string | null;
  head_name?: string;
  member_count?: number;
  [key: string]: unknown;
}

interface MemberRow {
  id: number | string;
  full_name?: string;
  username?: string;
  [key: string]: unknown;
}

interface DepartmentsProps {
  orgId?: number | string;
  userRole?: string;
}

const EMPTY_DEPARTMENTS: DepartmentRow[] = [];
const EMPTY_MEMBERS: MemberRow[] = [];

export default function Departments({ orgId, userRole }: DepartmentsProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [headId, setHeadId] = useState("");
  const [editId, setEditId] = useState<number | string | null>(null);
  const [editName, setEditName] = useState("");
  const [editHeadId, setEditHeadId] = useState("");
  const [msg, setMsg] = useAutoDismiss("");
  const canManage = ["hr_admin", "super_admin", "platform_admin"].includes(
    userRole ?? "",
  );
  const isAdmin = canManage;

  const { data: departments = EMPTY_DEPARTMENTS } = useQuery({
    queryKey: ["admin", "departments", orgId],
    queryFn: async (): Promise<DepartmentRow[]> =>
      (await getOrgDepartments(orgId ? { org_id: orgId } : undefined)).data,
  });

  const { data: members = EMPTY_MEMBERS } = useQuery({
    queryKey: ["admin", "members", orgId],
    queryFn: async (): Promise<MemberRow[]> => {
      const r = await getOrgMembers(
        orgId ? { is_active: true, org_id: orgId } : { is_active: true },
      );
      return r.data?.data ?? r.data;
    },
    enabled: canManage,
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createDepartment({
        name,
        head_id: headId || null,
        org_id: orgId || undefined,
      });
      setName("");
      setHeadId("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "departments"] });
    } catch (e: any) {
      setMsg(e.response?.data?.error || "Failed");
    }
  };

  const handleUpdate = async (id: number | string) => {
    try {
      await updateDepartment(id, {
        name: editName,
        head_id: editHeadId || null,
      });
      setEditId(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "departments"] });
    } catch (e: any) {
      setMsg(e.response?.data?.error || "Failed");
    }
  };

  const handleDelete = async (id: number | string) => {
    if (!confirm("Delete this department? Members will be unassigned.")) return;
    try {
      await deleteDepartment(id);
      queryClient.invalidateQueries({ queryKey: ["admin", "departments"] });
    } catch (e: any) {
      setMsg(e.response?.data?.error || "Failed");
    }
  };

  return (
    <>
      {msg && <div className={s.success}>{msg}</div>}
      {canManage && (
        <div className={su["form-toolbar"]}>
          {showForm ? (
            <form onSubmit={handleCreate} className={su["inline-form"]}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Department name"
                required
                className={su["form-inline-input"]}
              />
              <select
                value={headId}
                onChange={(e) => setHeadId(e.target.value)}
                className={su["form-inline-input"]}
              >
                <option value="">No Head</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name || m.username}
                  </option>
                ))}
              </select>
              <button type="submit" className={s.btnPrimary}>
                Add
              </button>
              <button
                type="button"
                className={s.btnCancel}
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button className={s.btnPrimary} onClick={() => setShowForm(true)}>
              + Add Department
            </button>
          )}
        </div>
      )}
      <table className={s.table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Head</th>
            {isAdmin && <th>Members</th>}
            {canManage && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {departments.map((d) => (
            <tr key={d.id}>
              <td>
                {editId === d.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className={su["edit-inline-input"]}
                  />
                ) : (
                  d.name
                )}
              </td>
              <td>
                {editId === d.id ? (
                  <select
                    value={editHeadId}
                    onChange={(e) => setEditHeadId(e.target.value)}
                    className={su["edit-inline-input"]}
                  >
                    <option value="">No Head</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name || m.username}
                      </option>
                    ))}
                  </select>
                ) : (
                  d.head_name || "—"
                )}
              </td>
              {isAdmin && <td>{d.member_count}</td>}
              {canManage && (
                <td>
                  <div className={s.actions}>
                    {editId === d.id ? (
                      <>
                        <button
                          className={`${s.btnSmall} ${s.btnAccent}`}
                          onClick={() => handleUpdate(d.id)}
                        >
                          Save
                        </button>
                        <button
                          className={`${s.btnSmall} ${s.btnSecondary}`}
                          onClick={() => setEditId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className={`${s.btnSmall} ${s.btnAccent}`}
                          onClick={() => {
                            setEditId(d.id);
                            setEditName(d.name);
                            setEditHeadId(d.head_id ? String(d.head_id) : "");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className={`${s.btnSmall} ${s.btnDanger}`}
                          onClick={() => handleDelete(d.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
          {departments.length === 0 && (
            <tr>
              <td
                colSpan={canManage ? 4 : isAdmin ? 3 : 2}
                className={s.emptyRow}
              >
                No departments yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

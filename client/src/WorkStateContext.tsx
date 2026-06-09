import {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    type Dispatch,
    type SetStateAction,
    type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { getStatus } from "./api";

interface WorkStateContextValue {
    workState: string;
    setWorkState: Dispatch<SetStateAction<string>>;
    workMode: string;
    setWorkMode: Dispatch<SetStateAction<string>>;
}

const WorkStateContext = createContext<WorkStateContextValue>({
    workState: "logged_out",
    setWorkState: () => {},
    workMode: "office",
    setWorkMode: () => {},
});

export function WorkStateProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated } = useAuth();
    const [workState, setWorkState] = useState("logged_out");
    const [workMode, setWorkMode] = useState("office");

    // Bootstrap work state from server on every page load/refresh so the
    // profile status dot is correct regardless of which page is active.
    useEffect(() => {
        if (!isAuthenticated) {
            setWorkState("logged_out");
            setWorkMode("office");
            return;
        }
        let cancelled = false;
        getStatus()
            .then((res) => {
                if (cancelled) return;
                setWorkState(res.data?.state || "logged_out");
                if (res.data?.workMode) setWorkMode(res.data.workMode);
            })
            .catch(() => {
                /* keep logged_out default on error */
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated]);

    const value = useMemo(
        () => ({ workState, setWorkState, workMode, setWorkMode }),
        [workState, workMode],
    );

    return (
        <WorkStateContext.Provider value={value}>
            {children}
        </WorkStateContext.Provider>
    );
}

export const useWorkState = () => useContext(WorkStateContext);
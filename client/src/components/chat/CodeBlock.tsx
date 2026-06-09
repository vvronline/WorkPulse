import { useEffect, useRef, useState } from "react";
import s from "./CodeBlock.module.css";

interface CodeBlockProps {
    code: string;
    language?: string;
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
    const codeRef = useRef<HTMLElement | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const hljs = (window as any).hljs;
        if (codeRef.current && hljs) {
            codeRef.current.textContent = code;
            if (language && hljs.getLanguage(language)) {
                hljs.highlightElement(codeRef.current);
            } else {
                hljs.highlightElement(codeRef.current);
            }
        }
    }, [code, language]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* ignore */ }
    };

    return (
        <div className={s.block}>
            <div className={s.header}>
                <span className={s.lang}>{language || "code"}</span>
                <button className={s.copyBtn} onClick={handleCopy}>
                    {copied ? "✓ Copied" : "Copy"}
                </button>
            </div>
            <pre className={s.pre}>
                <code ref={codeRef} className={language ? `language-${language}` : ""}>
                    {code}
                </code>
            </pre>
        </div>
    );
}
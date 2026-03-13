import { useEffect, useRef, useState } from 'react';
import s from './CodeBlock.module.css';

export default function CodeBlock({ code, language }) {
    const codeRef = useRef(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (codeRef.current && window.hljs) {
            codeRef.current.textContent = code;
            if (language && window.hljs.getLanguage(language)) {
                window.hljs.highlightElement(codeRef.current);
            } else {
                window.hljs.highlightElement(codeRef.current);
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
                <span className={s.lang}>{language || 'code'}</span>
                <button className={s.copyBtn} onClick={handleCopy}>
                    {copied ? '✓ Copied' : 'Copy'}
                </button>
            </div>
            <pre className={s.pre}>
                <code ref={codeRef} className={language ? `language-${language}` : ''}>
                    {code}
                </code>
            </pre>
        </div>
    );
}

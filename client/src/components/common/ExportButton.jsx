import React, { useState } from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';

/**
 * Generic export button — downloads a blob as CSV or PDF.
 * @param {function} fetchFn - API function that returns { data: Blob }
 * @param {object} params - Query params for the API call
 * @param {string} label - Button text
 */
export default function ExportButton({ fetchFn, params, label = 'Export' }) {
    const [loading, setLoading] = useState(false);

    const handleExport = async (format) => {
        setLoading(true);
        try {
            const res = await fetchFn({ ...params, format });
            const blob = new Blob([res.data], {
                type: format === 'pdf' ? 'application/pdf' : 'text/csv'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Extract filename from content-disposition or fallback
            const cd = res.headers['content-disposition'];
            const match = cd && cd.match(/filename="?(.+?)"?$/);
            a.download = match ? match[1] : `export.${format === 'pdf' ? 'pdf' : 'csv'}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            /* silent — NProgress shows failure */
        } finally {
            setLoading(false);
        }
    };

    return (
        <span className="export-btn-group" style={{ display: 'inline-flex', gap: '6px' }}>
            <button
                className="btn btn-sm btn-outline"
                onClick={() => handleExport('csv')}
                disabled={loading}
                title={`${label} CSV`}
            >
                <FileSpreadsheet size={14} style={{marginRight:4,verticalAlign:'middle'}} /> CSV
            </button>
            <button
                className="btn btn-sm btn-outline"
                onClick={() => handleExport('pdf')}
                disabled={loading}
                title={`${label} PDF`}
            >
                <FileText size={14} style={{marginRight:4,verticalAlign:'middle'}} /> PDF
            </button>
        </span>
    );
}

export default function PageSkeleton() {
    return (
        <div style={{ maxWidth: '1400px', margin: '2rem auto', padding: '0 2.5rem' }}>
            <div className="status-card">
                <div className="loading-spinner"><div className="spinner" /></div>
            </div>
        </div>
    );
}

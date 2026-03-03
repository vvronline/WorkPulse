import React from 'react';

export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo);
    }

    componentDidUpdate(prevProps) {
        // Reset error state when the resetKey changes (e.g., route navigation)
        if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ hasError: false, error: null });
        }
    }

    handleReload = () => {
        this.setState({ hasError: false, error: null });
        window.location.reload();
    };

    handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    maxWidth: 520,
                    margin: '4rem auto',
                    padding: '2.5rem',
                    background: 'var(--card-bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 16,
                    textAlign: 'center',
                    color: 'var(--text-primary)'
                }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
                    <h2 style={{ marginBottom: '0.5rem' }}>Something went wrong</h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                        An unexpected error occurred. You can try again or reload the page.
                    </p>
                    {!import.meta.env.PROD && this.state.error && (
                        <pre style={{
                            background: 'var(--input-bg)',
                            padding: '0.75rem',
                            borderRadius: 8,
                            fontSize: '0.75rem',
                            textAlign: 'left',
                            overflow: 'auto',
                            maxHeight: 120,
                            marginBottom: '1rem',
                            color: 'var(--danger, #ef4444)'
                        }}>
                            {this.state.error.toString()}
                        </pre>
                    )}
                    <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                        <button
                            onClick={this.handleRetry}
                            style={{
                                padding: '0.5rem 1.25rem', borderRadius: 8, border: '1px solid var(--border)',
                                background: 'var(--input-bg)', color: 'var(--text-primary)', cursor: 'pointer',
                                fontFamily: 'inherit', fontWeight: 600
                            }}
                        >
                            Try Again
                        </button>
                        <button
                            onClick={this.handleReload}
                            style={{
                                padding: '0.5rem 1.25rem', borderRadius: 8, border: 'none',
                                background: 'var(--primary)', color: '#fff', cursor: 'pointer',
                                fontFamily: 'inherit', fontWeight: 600
                            }}
                        >
                            Reload Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

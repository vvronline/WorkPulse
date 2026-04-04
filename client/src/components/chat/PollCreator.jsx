import { useState, useRef } from 'react';
import { BarChart3, X } from 'lucide-react';
import s from './PollCreator.module.css';

export default function PollCreator({ onSubmit, onClose }) {
    const [question, setQuestion] = useState('');
    const [options, setOptions] = useState(() => [
        { id: 1, value: '' }, { id: 2, value: '' }
    ]);
    const [multiSelect, setMultiSelect] = useState(false);
    const optIdCounter = useRef(3);

    const addOption = () => {
        if (options.length < 10) setOptions(prev => [...prev, { id: optIdCounter.current++, value: '' }]);
    };

    const removeOption = (id) => {
        if (options.length > 2) setOptions(prev => prev.filter(o => o.id !== id));
    };

    const updateOption = (id, val) => {
        setOptions(prev => prev.map(o => o.id === id ? { ...o, value: val } : o));
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        const clean = options.map(o => o.value.trim()).filter(Boolean);
        if (!question.trim() || clean.length < 2) return;
        onSubmit({ question: question.trim(), options: clean, multiSelect });
    };

    return (
        <div className={s.overlay}>
            <form className={s.modal} onSubmit={handleSubmit}>
                <div className={s.header}>
                    <h3><BarChart3 size={14} style={{marginRight:4,verticalAlign:'middle'}} />Create Poll</h3>
                    <button type="button" className={s.close} onClick={onClose}><X size={16} /></button>
                </div>
                <div className={s.body}>
                    <input
                        className={s.input}
                        placeholder="Ask a question..."
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        maxLength={500}
                        autoFocus
                    />
                    <div className={s.optionsList}>
                        {options.map((opt) => (
                            <div key={opt.id} className={s.optionRow}>
                                <input
                                    className={s.input}
                                    placeholder={`Option`}
                                    value={opt.value}
                                    onChange={e => updateOption(opt.id, e.target.value)}
                                    maxLength={200}
                                />
                                {options.length > 2 && (
                                    <button type="button" className={s.removeBtn} onClick={() => removeOption(opt.id)}><X size={14} /></button>
                                )}
                            </div>
                        ))}
                    </div>
                    {options.length < 10 && (
                        <button type="button" className={s.addBtn} onClick={addOption}>+ Add option</button>
                    )}
                    <label className={s.check}>
                        <input type="checkbox" checked={multiSelect} onChange={e => setMultiSelect(e.target.checked)} />
                        Allow multiple selections
                    </label>
                </div>
                <div className={s.footer}>
                    <button type="button" className={s.cancelBtn} onClick={onClose}>Cancel</button>
                    <button
                        type="submit"
                        className={s.submitBtn}
                        disabled={!question.trim() || options.filter(o => o.value.trim()).length < 2}
                    >Send Poll</button>
                </div>
            </form>
        </div>
    );
}

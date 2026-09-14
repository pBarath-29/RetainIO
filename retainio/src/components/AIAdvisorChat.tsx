import React, { useState, useEffect, useRef } from 'react';
import { isChurned } from '../accountStatus';
import { Account, AdvisorMessage } from '../types';
import { blocksNewOffer } from '../../pricing';
import { Bot, Send, ShieldCheck, ChevronDown, ChevronRight, Terminal, ArrowRight } from 'lucide-react';

interface AIAdvisorChatProps {
  initialAccount: Account | null;
  accounts: Account[];
  onOpenRetentionOffer: (account: Account) => void;
}

// Deliberately free of hardcoded numbers. The previous three said "Apply 10%
// discount" and "Apply 20% discount", which the chatbot cannot do and never
// could - and naming a percentage pre-empts the uplift model, whose job is to
// pick the tier. These ask the question and let the models answer it; between
// them they exercise SHAP, the uplift model, and case retrieval.
const SAMPLE_QUESTIONS = [
  'Why is this account at risk?',
  'What discount would actually help this account?',
  'Has anything like this happened before?',
];

// Every tool the LangGraph agent can call, in the order server.ts registers
// them, and labelled exactly as server.ts's TOOL_DISPLAY_NAMES labels them -
// so this list and the tool trace shown under each answer can never disagree.
// Six of the seven retrieve or compute something; the last one draws the
// retention offer card. It is listed because it does appear in the trace when
// the agent fires it.
const AGENT_TOOLS = [
  'Risk Analysis Engine',
  'SHAP Explanation Engine',
  'Uplift Model (Discount Optimiser)',
  'Historical Case RAG',
  'Knowledge Graph Search',
  'RAG Documents',
  'Retention Offer Card',
];

// The agent emits **bold** to highlight the figure it is citing, and the panel
// rendered it as literal asterisks - answers arrived reading
// "**99.0% churn risk score**". Rather than add a markdown dependency for one
// component, or strip the emphasis and lose the highlight, this renders the
// small subset the model actually produces.
//
// Builds React elements rather than setting innerHTML, so model output is never
// interpreted as markup.
function renderRichText(text: string) {
  return text.split('\n').map((line, lineIdx, lines) => (
    <span key={lineIdx}>
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4
          ? <strong key={i} className="font-bold text-slate-900">{part.slice(2, -2)}</strong>
          : <span key={i}>{part}</span>
      )}
      {lineIdx < lines.length - 1 && <br />}
    </span>
  ));
}

export const AIAdvisorChat: React.FC<AIAdvisorChatProps> = ({
  initialAccount,
  accounts,
  onOpenRetentionOffer
}) => {
  // Opens on a live account unless one was handed over; a churned one can still be picked.
  const [selectedAccount, setSelectedAccount] = useState<Account>(
    initialAccount || accounts.find(a => !isChurned(a)) || accounts[0]
  );
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // Tools the agent has fired during the run in flight, shown live and cleared
  // when the answer lands.
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [showToolLogs, setShowToolLogs] = useState<Record<string, boolean>>({});

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking]);

  // Handle One-Click Context Transfer when initialAccount changes or component mounts
  // Loads this account's stored thread. Previously this rebuilt a fresh
  // welcome message and threw away whatever had been said, so a conversation
  // did not survive a tab switch, a reload, opening the Retention Offer tab
  // (which unmounts this component), or picking a different account.
  useEffect(() => {
    if (!selectedAccount) return;
    let cancelled = false;

    (async () => {
      setIsLoadingHistory(true);
      try {
        const res = await fetch(`/api/accounts/${selectedAccount.id}/conversation`);
        if (!res.ok) throw new Error(`load failed: ${res.status}`);
        const data = await res.json();
        if (cancelled) return;

        setMessages(
          data.messages?.length
            ? data.messages
            : [{
                id: 'msg-init-' + Date.now(),
                sender: 'advisor',
                text: `Hello. I am RetainIO's Retention Advisor. I can analyse ${selectedAccount.name} using the trained churn, sentiment and uplift models, past retention cases, and our policy documents.

What would you like to know?`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              }]
        );
      } catch (err) {
        if (cancelled) return;
        console.error('Could not load conversation history:', err);
        // Say so rather than silently presenting an empty thread as a fresh
        // start - the difference matters if earlier advice is missing.
        setMessages([{
          id: 'msg-load-err-' + Date.now(),
          sender: 'system',
          text: 'Could not load the earlier conversation for this account. Anything you ask now will still be saved.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }]);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedAccount?.id]);

  // Handle sending a user message
  const handleSendMessage = async (textToSend?: string) => {
    const query = textToSend || inputMessage.trim();
    if (!query || isThinking) return;

    const userMsg: AdvisorMessage = {
      id: 'msg-user-' + Date.now(),
      sender: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    if (!textToSend) setInputMessage('');
    setLiveTools([]);
    setIsThinking(true);

    try {
      const response = await fetch('/api/gemini/advisor-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: query,
          contextAccount: selectedAccount,
          // messageHistory is no longer sent - the server rebuilds it from
          // conversation_messages, so it can't be shaped by the client.
        })
      });

      if (response.status === 401) {
        throw new Error('Your session has expired. Please sign in again.');
      }
      if (!response.ok) {
        // The server returns an honest failure body on 500 (see server.ts's
        // advisor-chat catch); surface that rather than guessing.
        const body = await response.json().catch(() => null);
        throw new Error(body?.text || `The advisor is unavailable right now (error ${response.status}).`);
      }

      // The response is an SSE stream, not a JSON blob: the server emits each
      // tool as it starts and finishes, then a final `done` event. EventSource
      // cannot be used because it only issues GETs, so the stream is read off
      // the response body directly.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The advisor returned no response body.');

      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; a partial trailing frame stays
        // in the buffer until the rest of it arrives.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventName = frame.match(/^event: (.+)$/m)?.[1];
          const rawData = frame.match(/^data: (.+)$/m)?.[1];
          if (!eventName || !rawData) continue;
          const payload = JSON.parse(rawData);

          if (eventName === 'tool_start') {
            setLiveTools(prev => [...prev, payload.toolName]);
          } else if (eventName === 'error') {
            throw new Error(payload.text);
          } else if (eventName === 'done') {
            setMessages(prev => [...prev, {
              id: 'msg-adv-' + Date.now(),
              sender: 'advisor',
              text: payload.text,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              toolCalls: payload.toolCalls,
              actionCard: payload.actionCard,
              ungroundedFigures: payload.ungroundedFigures,
            }]);
            finished = true;
          }
        }
      }
    } catch (err: any) {
      console.error('Advisor Chat API error:', err);
      // This used to fabricate an answer - a hardcoded "85% risk profile
      // driven by API usage drops" plus a live action card recommending 10%.
      // A network failure was indistinguishable from real analysis, and the
      // card navigated into the real approval flow on the strength of a made-up
      // number. server.ts was fixed to stop doing this; the client had not been.
      setMessages(prev => [
        ...prev,
        {
          id: 'msg-adv-err-' + Date.now(),
          sender: 'system',
          text: err?.message || 'Could not reach the advisor. No analysis was produced.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      ]);
    } finally {
      setIsThinking(false);
      setLiveTools([]);
    }
  };

  // The advisor only recommends — executing a discount (or walkthrough) always happens
  // through the real Retention Offer pipeline, which has email review, walkthrough support,
  // director escalation, and audit logging. This just navigates there.
  const handleGoToRetentionOffer = (accountId?: string) => {
    const targetAccount = accounts.find(a => a.id === accountId) || selectedAccount;
    onOpenRetentionOffer(targetAccount);
  };

  const toggleToolLogs = (msgId: string) => {
    setShowToolLogs(prev => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-140px)]">
      
      {/* Sidebar: Account Selector & Context */}
      <div className="lg:col-span-1 bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between space-y-4 overflow-y-auto shadow-xs">
        <div className="space-y-4">
          <div>
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">
              Active Context Account
            </span>
            <select
              value={selectedAccount.id}
              onChange={(e) => {
                const acc = accounts.find(a => a.id === e.target.value);
                if (acc) setSelectedAccount(acc);
              }}
              className="w-full bg-slate-50 border border-slate-200 text-slate-800 text-xs rounded-lg p-2.5 font-semibold focus:outline-none focus:border-slate-400"
            >
              {/* Customers who have left come last and are marked, so the advisor can still be asked why one
                  left without it reading as a live account. */}
              {[...accounts.filter(a => !isChurned(a)), ...accounts.filter(a => isChurned(a))].map(a => (
                <option key={a.id} value={a.id}>
                  {isChurned(a)
      ? `${a.name} (churned, ${a.fusionRiskScore != null ? `last risk ${a.fusionRiskScore}%` : 'never scored'})`
      : `${a.name} (${a.fusionRiskScore}% Risk)`}
                </option>
              ))}
            </select>
          </div>

          {/* Account Snapshot Badge */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="font-bold text-slate-900">{selectedAccount.name}</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-700 border border-red-200">
                {selectedAccount.fusionRiskScore}% Risk
              </span>
            </div>
            <div className="text-[11px] text-slate-600 space-y-1">
              <div>Usage Score: <strong className="text-slate-800">{selectedAccount.churnModelScore}%</strong></div>
              <div>Sentiment: <strong className="text-slate-800">{selectedAccount.sentimentClassification}</strong></div>
              <div>
                MRR: <strong className="text-slate-900">${selectedAccount.effectiveMrr.toLocaleString()}</strong>
                {selectedAccount.discountState === 'active' && (
                  <span className="text-slate-400"> (list ${selectedAccount.mrr.toLocaleString()})</span>
                )}
              </div>
            </div>
          </div>

          {/* Connected Analytics Engines */}
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
              {AGENT_TOOLS.length} Agent Tools
            </span>

            <div className="space-y-1 text-[11px] text-slate-700">
              {AGENT_TOOLS.map(name => (
                <div key={name} className="flex items-center space-x-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="w-2 h-2 rounded-full bg-slate-800" />
                  <span>{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Quick Prompts */}
        <div className="space-y-2 pt-2 border-t border-slate-200">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Sample Questions</span>
          {SAMPLE_QUESTIONS.map(q => (
            <button
              key={q}
              onClick={() => handleSendMessage(q.replace('this account', selectedAccount.name))}
              className="w-full text-left p-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-[11px] text-slate-800 border border-slate-200 transition font-medium"
            >
              "{q}"
            </button>
          ))}
        </div>

      </div>

      {/* Main Chat Interface */}
      <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl flex flex-col justify-between overflow-hidden shadow-xs">
        
        {/* Chat Header */}
        <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-white">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-white">
              <Bot className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-white text-sm">Advisor Assistant</h3>
              <p className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">RETENTION POLICY ENGINE</p>
            </div>
          </div>

          <span className="text-xs px-2.5 py-1 rounded-md bg-slate-800 text-slate-200 border border-slate-700 font-medium">
            Account: {selectedAccount.name}
          </span>
        </div>

        {/* Chat Feed */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-4 flex-1 bg-slate-50/50">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.sender === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              {/* System Info Banner */}
              {msg.sender === 'system' ? (
                <div className="w-full my-2 bg-slate-200/80 border border-slate-300 text-slate-700 p-2.5 rounded-lg text-xs text-center font-mono">
                  {msg.text}
                </div>
              ) : (
                <div className={`max-w-2xl rounded-xl p-4 text-xs space-y-3 ${
                  msg.sender === 'user'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-white border border-slate-200 text-slate-800 shadow-xs'
                }`}>
                  
                  <div className="flex items-center justify-between space-x-4 border-b border-slate-200/40 pb-1.5 text-[10px] opacity-70">
                    <span className="font-bold uppercase tracking-wider">
                      {msg.sender === 'user' ? 'Account Manager (Sarah)' : 'Advisor Assistant'}
                    </span>
                    <span>{msg.timestamp}</span>
                  </div>

                  <p className="leading-relaxed whitespace-pre-wrap text-xs">{renderRichText(msg.text)}</p>

                  {/* Every figure in an answer should trace back to a tool that
                      ran. When one does not, say so here rather than let it
                      read with the same authority as a real model output. */}
                  {msg.ungroundedFigures && msg.ungroundedFigures.length > 0 && (
                    <p className="mt-2 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                      Unverified: {msg.ungroundedFigures.join(', ')} — {msg.ungroundedFigures.length === 1 ? 'this figure was' : 'these figures were'} not produced by any tool in this answer. Check before acting on {msg.ungroundedFigures.length === 1 ? 'it' : 'them'}.
                    </p>
                  )}

                  {/* Tool Execution Logs Drawer */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-200">
                      <button
                        onClick={() => toggleToolLogs(msg.id)}
                        className="flex items-center space-x-1.5 text-[10px] text-slate-600 font-mono hover:underline font-semibold"
                      >
                        <Terminal className="w-3 h-3" />
                        <span>
                          {showToolLogs[msg.id] ? 'Hide Tool Execution Log' : `View ${msg.toolCalls.length} Tool Execution Steps`}
                        </span>
                        {showToolLogs[msg.id] ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </button>

                      {showToolLogs[msg.id] && (
                        <div className="mt-2 space-y-1.5 bg-slate-900 p-3 rounded-lg text-white text-[10px] font-mono">
                          {msg.toolCalls.map((tool, idx) => (
                            <div key={idx} className="space-y-0.5">
                              <span className="text-amber-300 font-bold">⚙️ {tool.toolName}</span>
                              <div className="text-slate-400 pl-3">Args: {JSON.stringify(tool.args)}</div>
                              <div className="text-emerald-400 pl-3">Output: {tool.output}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action Cards */}
                  {msg.actionCard && (() => {
                    const cardAccount = accounts.find(a => a.id === msg.actionCard?.accountId);
                    // Scheduled or running blocks a new offer; an ended one does not.
                    const cardHasActiveDiscount = cardAccount ? blocksNewOffer(cardAccount.discountState) : false;

                    return (
                    <div className="mt-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
                      <div className="flex items-center space-x-2 text-slate-900 font-bold text-xs">
                        <ShieldCheck className="w-4 h-4 text-slate-800" />
                        <span>Recommended Retention Plan</span>
                      </div>

                      <p className="text-[11px] text-slate-600">
                        {`Advisor recommends a ${msg.actionCard.discountPct}% retention rate adjustment for ${msg.actionCard.accountName}.`}
                      </p>

                      {cardHasActiveDiscount ? (
                        <p className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                          {cardAccount?.name} has {cardAccount?.discountLabel} — a new one can't be stacked on top.
                        </p>
                      ) : (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {/* One action, and it only navigates. Dismiss used to
                            sit beside this: it wrote nothing, the server never
                            saw it, and system messages are filtered out of the
                            agent's history - so it read as a decision being
                            recorded when nothing was. */}
                        <button
                          onClick={() => handleGoToRetentionOffer(msg.actionCard?.accountId)}
                          className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 transition shadow-xs flex items-center space-x-1.5"
                        >
                          <span>Open Retention Offer Tab</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      )}
                    </div>
                    );
                  })()}

                </div>
              )}
            </div>
          ))}

          {isLoadingHistory && (
            <div className="flex items-center space-x-2 text-xs text-slate-500 bg-white border border-slate-200 p-3 rounded-lg max-w-xs">
              <Bot className="w-4 h-4 text-slate-400 animate-spin" />
              <span>Loading earlier conversation...</span>
            </div>
          )}

          {/* Was a single static "Analyzing telemetry..." line for the whole
              run, however many tools it took. Now each tool appears as the
              agent fires it. */}
          {isThinking && (
            <div className="text-xs text-slate-600 bg-white border border-slate-200 p-3 rounded-lg max-w-sm space-y-1.5">
              <div className="flex items-center space-x-2">
                <Bot className="w-4 h-4 text-slate-800 animate-spin" />
                <span>{liveTools.length ? 'Running analytics engines...' : 'Thinking...'}</span>
              </div>
              {liveTools.map((name, i) => (
                <div key={`${name}-${i}`} className="flex items-center space-x-2 pl-6 text-[11px] text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>{name}</span>
                </div>
              ))}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input. The send button was already disabled while thinking,
            but Enter was not - holding it fired concurrent agent runs, each a
            full multi-tool Gemini call. */}
        <div className="p-4 bg-white border-t border-slate-200 flex items-center space-x-2">
          <label htmlFor="chat-message-input" className="sr-only">Message to Advisor</label>
          <input
            id="chat-message-input"
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !isThinking) handleSendMessage(); }}
            disabled={isThinking}
            placeholder={isThinking ? 'Waiting for the advisor...' : `Ask Advisor about ${selectedAccount.name}...`}
            className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-slate-400 disabled:opacity-60"
          />
          <button
            onClick={() => handleSendMessage()}
            disabled={!inputMessage.trim() || isThinking}
            className="p-2.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>

      </div>

    </div>
  );
};

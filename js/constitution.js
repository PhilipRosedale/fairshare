// Word-level diff: returns array of { type: 'same'|'ins'|'del', text } objects
function wordDiffRaw(oldText, newText) {
    const oldWords = oldText.split(/(\s+)/);
    const newWords = newText.split(/(\s+)/);

    // Simple LCS-based diff
    const m = oldWords.length, n = newWords.length;
    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldWords[i - 1] === newWords[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to build diff
    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
            result.unshift({ type: 'same', text: oldWords[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'ins', text: newWords[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'del', text: oldWords[i - 1] });
            i--;
        }
    }

    return result;
}

// Word-level diff: produces HTML with <ins> and <del> spans
function wordDiff(oldText, newText) {
    return wordDiffRaw(oldText, newText).map(r => {
        const t = esc(r.text);
        if (r.type === 'ins') return `<ins>${t}</ins>`;
        if (r.type === 'del') return `<del>${t}</del>`;
        return t;
    }).join('');
}

const CONSTITUTION_TAG_RE = /\s*\$([A-Z_]+)/g;

function stripConstitutionTags(text) {
    if (!text) return '';
    return text.replace(CONSTITUTION_TAG_RE, '');
}

function getConstitutionTagAnchor(beforeTagStripped) {
    const labelMatch = beforeTagStripped.match(/([^\n]*:\s*)$/);
    if (labelMatch) return labelMatch[1];
    const periodMatch = beforeTagStripped.match(/([\s\S]*?\bperiod of\s*)$/i);
    if (periodMatch) return periodMatch[1];
    return beforeTagStripped.slice(Math.max(0, beforeTagStripped.length - 40));
}

function findConstitutionTagInsertAt(text, valueStart, tagName) {
    let end = text.length;
    const commaWith = text.indexOf(', with', valueStart);
    if (commaWith !== -1) end = Math.min(end, commaWith);
    const commaAnd = text.indexOf(', and', valueStart);
    if (commaAnd !== -1) end = Math.min(end, commaAnd);
    const lineEnd = text.indexOf('\n', valueStart);
    if (lineEnd !== -1) end = Math.min(end, lineEnd);
    if (tagName.includes('PERCENTAGE') || tagName.includes('CURRENCY')) {
        const ofMember = text.indexOf(' of member', valueStart);
        if (ofMember !== -1) end = Math.min(end, ofMember);
    }
    if (tagName === 'VOTING_PERIOD_DAYS') {
        const comma = text.indexOf(',', valueStart);
        if (comma !== -1) end = Math.min(end, comma);
    }
    return end;
}

// Re-insert machine-readable $TAG identifiers before saving edited display text.
function restoreConstitutionTags(displayText, templateText) {
    const display = displayText ?? '';
    if (!templateText) return display;

    const tagMatches = [...templateText.matchAll(CONSTITUTION_TAG_RE)];
    if (tagMatches.length === 0) return display;

    let probe = display;
    let hasAllTags = true;
    for (const tm of tagMatches) {
        const idx = probe.indexOf(tm[0]);
        if (idx === -1) {
            hasAllTags = false;
            break;
        }
        probe = probe.slice(idx + tm[0].length);
    }
    if (hasAllTags) return display;

    let text = stripConstitutionTags(display);
    for (let i = tagMatches.length - 1; i >= 0; i--) {
        const tm = tagMatches[i];
        if (text.includes(tm[0])) continue;

        const before = stripConstitutionTags(templateText.slice(0, tm.index));
        const exactPos = text.indexOf(before);
        if (exactPos !== -1) {
            const insertAt = exactPos + before.length;
            text = text.slice(0, insertAt) + tm[0] + text.slice(insertAt);
            continue;
        }

        const anchor = getConstitutionTagAnchor(before);
        const anchorPos = text.indexOf(anchor);
        if (anchorPos === -1) continue;
        const insertAt = findConstitutionTagInsertAt(text, anchorPos + anchor.length, tm[1]);
        text = text.slice(0, insertAt) + tm[0] + text.slice(insertAt);
    }
    return text;
}

// Render constitution text for display (hide machine-readable $TAG identifiers)
function renderConstitution(text) {
    if (!text) return '<em style="color:var(--dark-gray);">No constitution yet.</em>';
    return esc(stripConstitutionTags(text));
}

// Parse $AMENDMENT_PERCENTAGE from constitution text (returns 0-1)
function parseAmendmentThreshold(constitutionText) {
    if (!constitutionText) return 1.0; // default 100%
    const match = constitutionText.match(/(\d+)%\s*(?:members?\s*)?\$AMENDMENT_PERCENTAGE/i);
    if (match) return parseInt(match[1]) / 100;
    return 1.0;
}

function parseAccordThreshold(constitutionText) {
    if (!constitutionText) return 0.5; // default 50%
    const match = constitutionText.match(/(\d+)%\s*(?:members?\s*)?\$ACCORD_PERCENTAGE/i);
    if (match) return parseInt(match[1], 10) / 100;
    return 0.5;
}

function parseNewMemberThreshold(constitutionText) {
    if (!constitutionText) return 1.0; // default 100%
    const match = constitutionText.match(/(\d+)%\s*(?:members?\s*)?\$NEW_MEMBER_PERCENTAGE/i);
    if (match) return parseInt(match[1]) / 100;
    return 1.0;
}

function parseVotingPeriodDays(constitutionText) {
    if (!constitutionText) return null;
    const match = constitutionText.match(/(\d+)\s*days?\s*\$VOTING_PERIOD_DAYS/i);
    return match ? parseInt(match[1], 10) : null;
}

function isVotingPeriodMode(constitutionText) {
    const days = parseVotingPeriodDays(constitutionText);
    return days != null && days > 0;
}

async function ensureVotingFinalized(groupId) {
    const constitution = selectedGroup?.constitution;
    if (!groupId || !isVotingPeriodMode(constitution)) return;
    try {
        await db.rpc('finalize_expired_voting', { p_group_id: groupId });
    } catch (e) {
        console.warn('ensureVotingFinalized:', e);
    }
}

// Build word-level attribution by replaying edit history diffs.
// Returns an array of { word, user_id, created_at } for each word in the final content.
function buildWordAttribution(history) {
    if (!history || history.length === 0) return [];

    // Start with the first revision — all words attributed to its author
    let prevWords = history[0].content.split(/(\s+)/);
    let attribution = prevWords.map(w => ({
        word: w,
        user_id: history[0].user_id,
        created_at: history[0].created_at
    }));

    // Replay each subsequent revision
    for (let h = 1; h < history.length; h++) {
        const rev = history[h];
        const newWords = rev.content.split(/(\s+)/);
        const diff = wordDiffRaw(
            prevWords.join(''),
            newWords.join('')
        );

        // Walk through the diff and build a new attribution array
        const newAttribution = [];
        let oldIdx = 0;  // pointer into previous attribution array

        for (const entry of diff) {
            if (entry.type === 'same') {
                // Carry forward the existing attribution
                // Find the matching old word
                while (oldIdx < attribution.length && attribution[oldIdx].word !== entry.text) {
                    oldIdx++;
                }
                if (oldIdx < attribution.length) {
                    newAttribution.push(attribution[oldIdx]);
                    oldIdx++;
                } else {
                    // Fallback — shouldn't happen, but attribute to current revision
                    newAttribution.push({ word: entry.text, user_id: rev.user_id, created_at: rev.created_at });
                }
            } else if (entry.type === 'ins') {
                // New/inserted word — attribute to this revision's author
                newAttribution.push({ word: entry.text, user_id: rev.user_id, created_at: rev.created_at });
            }
            // 'del' entries are dropped (they no longer exist in the new text)
        }

        attribution = newAttribution;
        prevWords = newWords;
    }

    return attribution;
}

// Render the document content with hover attribution spans
function renderAttributedDocument(attribution, profileMap) {
    if (attribution.length === 0) {
        return '<p style="color:var(--dark-gray);font-style:italic;">No content yet. Click Edit to add something.</p>';
    }

    let html = '<div class="group-doc-text" style="white-space:pre-wrap;word-wrap:break-word;line-height:1.7;font-size:0.95rem;">';
    for (const item of attribution) {
        const name = profileMap[item.user_id] || 'Unknown';
        const date = new Date(item.created_at);
        const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const tooltip = `${name} — ${dateStr}`;
        // Only wrap non-whitespace tokens in spans (whitespace renders as-is)
        if (item.word.trim()) {
            html += `<span title="${esc(tooltip)}" style="cursor:default;">${esc(item.word)}</span>`;
        } else {
            html += esc(item.word);
        }
    }
    html += '</div>';
    return html;
}

let _docLoadGen = 0;
async function loadGroupDocument() {
    if (!selectedGroup) return;
    const myGen = ++_docLoadGen;
    const groupId = selectedGroup.id;
    const el = document.getElementById('groupDocContent');
    if (!el) return;
    el.innerHTML = '<p style="color:var(--dark-gray);">Loading…</p>';

    try {
        // Fetch current document and full history in parallel
        const [docResult, histResult] = await Promise.all([
            db.from('group_documents').select('*').eq('group_id', groupId).maybeSingle(),
            db.from('document_history').select('*').eq('group_id', groupId).order('created_at', { ascending: true })
        ]);

        if (myGen !== _docLoadGen) return;

        if (docResult.error) {
            console.error('loadGroupDocument error:', docResult.error);
            el.innerHTML = `<p style="color:var(--red);">Error loading document: ${esc(docResult.error.message)}</p>`;
            return;
        }

        const doc = docResult.data;
        const history = histResult.data || [];

        // Build a profile name map for all authors in the history
        const authorIds = [...new Set(history.map(h => h.user_id))];
        const profileMap = {};
        for (const uid of authorIds) {
            profileMap[uid] = await getDisplayName(uid);
        }

        if (myGen !== _docLoadGen) return;

        // Build attribution if there's content
        let contentHtml;
        if (doc && doc.content && doc.content.trim()) {
            const attribution = buildWordAttribution(history);
            contentHtml = renderAttributedDocument(attribution, profileMap);
        } else {
            contentHtml = '<p style="color:var(--dark-gray);font-style:italic;">No content yet. Click Edit to add something.</p>';
        }

        let html = contentHtml;
        html += `<div style="margin-top:0.75rem;">
            <button class="btn btn-secondary btn-small" onclick="editGroupDocument()">Edit</button>
        </div>`;

        if (myGen !== _docLoadGen) return;
        el.innerHTML = html;
    } catch (e) {
        console.error('loadGroupDocument error:', e);
        if (myGen === _docLoadGen) {
            el.innerHTML = `<p style="color:var(--red);">Failed to load document: ${esc(e.message || e)}</p>`;
        }
    }
}

function editGroupDocument() {
    const el = document.getElementById('groupDocContent');
    if (!el) return;

    // Fetch current text from the rendered content (or empty for new)
    const existingTextEl = el.querySelector('.group-doc-text');
    let currentText = '';
    if (existingTextEl) {
        currentText = existingTextEl.textContent;
    }

    el.innerHTML = `
        <textarea id="groupDocEditor" rows="10"
            style="width:100%;font-family:inherit;font-size:0.95rem;line-height:1.6;padding:0.75rem;border:1px solid var(--medium-gray);border-radius:6px;resize:vertical;"
            placeholder="Use this space for announcements, marketplace listings, contact info, or anything the group wants to share…"
        >${esc(currentText)}</textarea>
        <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
            <button class="btn btn-primary btn-small" onclick="saveGroupDocument()">Save</button>
            <button class="btn btn-secondary btn-small" onclick="loadGroupDocument()">Cancel</button>
        </div>
    `;

    // Focus the editor
    const editor = document.getElementById('groupDocEditor');
    if (editor) editor.focus();
}

async function saveGroupDocument() {
    if (!selectedGroup) return;
    const editor = document.getElementById('groupDocEditor');
    if (!editor) return;

    const content = editor.value;

    // Disable buttons while saving
    editor.disabled = true;
    const buttons = editor.parentElement.querySelectorAll('button');
    buttons.forEach(b => b.disabled = true);

    try {
        const { data, error } = await db.rpc('save_document', {
            p_group_id: selectedGroup.id,
            p_content: content
        });

        if (error) {
            showToast('Failed to save document: ' + error.message, 'error');
            editor.disabled = false;
            buttons.forEach(b => b.disabled = false);
            return;
        }

        showToast('Document saved', 'success');
        await loadGroupDocument();
    } catch (e) {
        showToast('Failed to save document: ' + (e.message || e), 'error');
        editor.disabled = false;
        buttons.forEach(b => b.disabled = false);
    }
}

// Load the Constitution content
let _constitutionLoadGen = 0;  // generation counter to prevent stale writes
async function loadConstitutionContent() {
    if (!selectedGroup) return;
    const myGen = ++_constitutionLoadGen;       // claim this generation
    const groupId = selectedGroup.id;           // pin the group id
    const el = document.getElementById('constitutionContent');
    if (!el) return;
    el.innerHTML = '<p style="color:var(--dark-gray);">Loading…</p>';

    try {
        await ensureVotingFinalized(groupId);

        // Refresh group data to get latest constitution
        const { data: freshGroup, error: groupErr } = await db
            .from('groups')
            .select('*')
            .eq('id', groupId)
            .single();

        if (myGen !== _constitutionLoadGen) return;  // stale – a newer call took over

        if (groupErr) {
            console.error('loadConstitution group fetch error:', groupErr);
            el.innerHTML = `<p style="color:var(--red);">Error loading group data: ${esc(groupErr.message)}</p>`;
            return;
        }
        if (freshGroup) {
            selectedGroup = freshGroup;   // safe: we checked generation
        }

        const constitutionHtml = `<div class="constitution-text">${renderConstitution(selectedGroup.constitution)}</div>`;

        // Load active and past amendments/proposals in parallel
        const [activeResult, pastResult, activeProposalResult, pastProposalResult, memberResult] = await Promise.all([
            db.from('amendments')
                .select('*, proposer:profiles(display_name)')
                .eq('group_id', groupId)
                .eq('status', 'voting')
                .order('created_at', { ascending: false }),
            db.from('amendments')
                .select('*, proposer:profiles(display_name)')
                .eq('group_id', groupId)
                .in('status', ['passed', 'failed', 'withdrawn'])
                .order('resolved_at', { ascending: false })
                .limit(20),
            db.from('accord_proposals')
                .select('*, proposer:profiles(display_name)')
                .eq('group_id', groupId)
                .eq('status', 'voting')
                .order('created_at', { ascending: false }),
            db.from('accord_proposals')
                .select('*, proposer:profiles(display_name)')
                .in('status', ['passed', 'failed', 'withdrawn'])
                .eq('group_id', groupId)
                .order('resolved_at', { ascending: false })
                .limit(20),
            db.from('members')
                .select('*', { count: 'exact', head: true })
                .eq('group_id', groupId)
                .eq('status', 'active')
        ]);

        if (myGen !== _constitutionLoadGen) return;  // stale

        if (activeResult.error) console.warn('loadConstitution active amendments error:', activeResult.error);
        if (pastResult.error) console.warn('loadConstitution past amendments error:', pastResult.error);
        if (activeProposalResult.error) console.warn('loadConstitution active proposals error:', activeProposalResult.error);
        if (pastProposalResult.error) console.warn('loadConstitution proposal history error:', pastProposalResult.error);

        const activeAmendments = activeResult.data;
        const pastAmendments = pastResult.data;
        const activeProposals = activeProposalResult.data;
        const pastProposals = pastProposalResult.data;
        const activeMembers = memberResult.count;

        // Get vote counts for all amendments and proposals we're showing
        const allAmendmentIds = [
            ...(activeAmendments || []).map(a => a.id),
            ...(pastAmendments || []).map(a => a.id)
        ];
        const allProposalIds = [
            ...(activeProposals || []).map(a => a.id),
            ...(pastProposals || []).map(a => a.id)
        ];

        let amendmentVotesMap = {};
        let myAmendmentVotesMap = {};
        if (allAmendmentIds.length > 0) {
            const { data: votes } = await db
                .from('amendment_votes')
                .select('amendment_id, user_id, vote')
                .in('amendment_id', allAmendmentIds);

            if (myGen !== _constitutionLoadGen) return;  // stale

            (votes || []).forEach(v => {
                if (!amendmentVotesMap[v.amendment_id]) amendmentVotesMap[v.amendment_id] = { approve: 0, reject: 0 };
                if (v.vote) amendmentVotesMap[v.amendment_id].approve++;
                else amendmentVotesMap[v.amendment_id].reject++;
                if (v.user_id === currentUser.id) myAmendmentVotesMap[v.amendment_id] = v.vote;
            });
        }

        let proposalVotesMap = {};
        let myProposalVotesMap = {};
        if (allProposalIds.length > 0) {
            const { data: votes } = await db
                .from('accord_votes')
                .select('accord_id, user_id, vote')
                .in('accord_id', allProposalIds);

            if (myGen !== _constitutionLoadGen) return;

            (votes || []).forEach(v => {
                if (!proposalVotesMap[v.accord_id]) proposalVotesMap[v.accord_id] = { approve: 0, reject: 0 };
                if (v.vote) proposalVotesMap[v.accord_id].approve++;
                else proposalVotesMap[v.accord_id].reject++;
                if (v.user_id === currentUser.id) myProposalVotesMap[v.accord_id] = v.vote;
            });
        }

        let html = constitutionHtml;
        const acceptedAccords = (pastProposals || []).filter((p) => p.status === 'passed');
        if (acceptedAccords.length > 0) {
            html += `<h4 style="margin:1.25rem 0 0.5rem;color:var(--accent-color);">Accepted Accords</h4>`;
            html += acceptedAccords.map((a) => renderAcceptedAccord(a)).join('');
        }

        // Governance action buttons
        html += `<div style="margin:1rem 0;">
            <button class="btn btn-primary" onclick="showModal('proposeAmendment')">Propose Constitutional Amendment</button>
            <button class="btn btn-secondary" onclick="showModal('createProposal')">Create Proposal</button>
        </div>`;

        // Active amendments
        if (activeAmendments && activeAmendments.length > 0) {
            html += `<h4 style="margin:1.5rem 0 0.5rem;color:var(--accent-color);">Active Amendments</h4>`;
            html += activeAmendments.map(a => renderAmendmentCard(a, amendmentVotesMap, myAmendmentVotesMap, activeMembers)).join('');
        }

        // Past amendments
        if (pastAmendments && pastAmendments.length > 0) {
            html += `<h4 style="margin:1.5rem 0 0.5rem;color:var(--accent-color);">Amendment History</h4>`;
            html += pastAmendments.map(a => renderAmendmentCard(a, amendmentVotesMap, myAmendmentVotesMap, activeMembers)).join('');
        }

        // Active proposals
        if (activeProposals && activeProposals.length > 0) {
            html += `<h4 style="margin:1.5rem 0 0.5rem;color:var(--accent-color);">Active Proposals</h4>`;
            html += activeProposals.map(a => renderProposalCard(a, proposalVotesMap, myProposalVotesMap, activeMembers)).join('');
        }

        // Past proposals
        if (pastProposals && pastProposals.length > 0) {
            html += `<h4 style="margin:1.5rem 0 0.5rem;color:var(--accent-color);">Proposal History</h4>`;
            html += pastProposals.map(a => renderProposalCard(a, proposalVotesMap, myProposalVotesMap, activeMembers)).join('');
        }

        if (myGen !== _constitutionLoadGen) return;  // final stale check before DOM write
        el.innerHTML = html;
    } catch (e) {
        console.error('loadConstitution error:', e);
        if (myGen === _constitutionLoadGen) {
            el.innerHTML = `<p style="color:var(--red);">Failed to load constitution: ${esc(e.message || e)}</p>`;
        }
    }
}

function renderAcceptedAccord(a) {
    const proposer = esc(a.proposer?.display_name || 'Unknown');
    const votedInDate = a.resolved_at ? new Date(a.resolved_at).toLocaleDateString() : 'Unknown date';
    const accordText = a.text || '';
    const lines = accordText.split(/\r?\n/);
    const firstLine = (lines[0] || '').trim() || 'Untitled Accord';
    return `<details class="accord-entry">
        <summary>${esc(firstLine)}</summary>
        <div class="accord-entry-body">
            <div class="amendment-meta">Proposed by ${proposer} &middot; Voted in ${votedInDate}</div>
            <div class="diff-display" style="margin-top:0.5rem;">${esc(accordText)}</div>
        </div>
    </details>`;
}

function renderAmendmentCard(a, votesMap, myVotesMap, activeMemberCount) {
    const votes = votesMap[a.id] || { approve: 0, reject: 0 };
    const myVote = myVotesMap[a.id];
    const periodMode = isVotingPeriodMode(selectedGroup?.constitution);
    const voterTotal = periodMode
        ? Math.max(1, votes.approve + votes.reject)
        : (activeMemberCount || 1);
    const total = voterTotal;
    const pct = total > 0 ? (votes.approve / total * 100) : 0;
    const thresholdPct = (a.threshold * 100);
    const countLabel = periodMode ? `${votes.approve}/${total} voted` : `${votes.approve}/${total}`;
    const now = new Date();
    const expires = new Date(a.expires_at);
    const isExpired = expires <= now;
    const timeLeft = isExpired ? 'Expired' : formatTimeLeft(expires - now);

    let diffHtml = wordDiff(
        stripConstitutionTags(a.old_text || ''),
        stripConstitutionTags(a.new_text || '')
    );

    let actions = '';
    if (a.status === 'voting') {
        if (isExpired) {
            actions = `<button class="btn btn-primary btn-small" onclick="resolveAmendment('${a.id}')">Resolve Vote</button>`;
        } else {
            const approveClass = myVote === true ? 'btn-success' : 'btn-outline';
            const rejectClass = myVote === false ? 'btn-danger' : 'btn-outline';
            actions = `
                <button class="btn ${approveClass} btn-small" onclick="voteAmendment('${a.id}', true)"
                    ${myVote === true ? 'disabled' : ''}>Approve${myVote === true ? 'd' : ''}</button>
                <button class="btn ${rejectClass} btn-small" onclick="voteAmendment('${a.id}', false)"
                    ${myVote === false ? 'disabled' : ''}>Reject${myVote === false ? 'ed' : ''}</button>
            `;
            if (a.proposed_by === currentUser.id) {
                actions += ` <button class="btn btn-secondary btn-small" onclick="withdrawAmendment('${a.id}')">Withdraw</button>`;
            }
        }
    }

    return `<div class="amendment-card ${a.status}">
        <div class="amendment-header">
            <span class="amendment-title">${esc(a.title)}</span>
            <span class="amendment-status ${a.status}">${a.status}</span>
        </div>
        <div class="amendment-meta">
            Proposed by ${esc(a.proposer?.display_name || 'Unknown')}
            &middot; ${a.status === 'voting' ? timeLeft : (a.resolved_at ? new Date(a.resolved_at).toLocaleDateString() : '')}
        </div>
        <div class="vote-bar">
            <span style="font-size:0.8rem;font-weight:600;">${countLabel}</span>
            <div class="vote-bar-track">
                <div class="vote-bar-fill" style="width:${pct}%"></div>
                <div class="vote-bar-threshold" style="left:${thresholdPct}%" title="Threshold: ${thresholdPct}%"></div>
            </div>
            <span style="font-size:0.75rem;color:var(--dark-gray);">need ${thresholdPct}%</span>
        </div>
        <details style="margin:0.5rem 0;">
            <summary style="cursor:pointer;font-size:0.85rem;color:var(--primary-color);font-weight:500;">Show changes</summary>
            <div class="diff-display" style="margin-top:0.5rem;">${diffHtml}</div>
        </details>
        ${actions ? `<div style="display:flex;gap:0.5rem;margin-top:0.5rem;">${actions}</div>` : ''}
    </div>`;
}

function renderProposalCard(a, votesMap, myVotesMap, activeMemberCount) {
    const votes = votesMap[a.id] || { approve: 0, reject: 0 };
    const myVote = myVotesMap[a.id];
    const periodMode = isVotingPeriodMode(selectedGroup?.constitution);
    const voterTotal = periodMode
        ? Math.max(1, votes.approve + votes.reject)
        : (activeMemberCount || 1);
    const total = voterTotal;
    const pct = total > 0 ? (votes.approve / total * 100) : 0;
    const parsedThreshold = Number(a.threshold);
    const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : parseAccordThreshold(selectedGroup?.constitution);
    const thresholdPct = threshold * 100;
    const countLabel = periodMode ? `${votes.approve}/${total} voted` : `${votes.approve}/${total}`;
    const now = new Date();
    const expires = new Date(a.expires_at);
    const isExpired = expires <= now;
    const timeLeft = isExpired ? 'Expired' : formatTimeLeft(expires - now);

    let actions = '';
    if (a.status === 'voting') {
        if (isExpired) {
            actions = `<button class="btn btn-primary btn-small" onclick="resolveProposal('${a.id}')">Resolve Vote</button>`;
        } else {
            const approveClass = myVote === true ? 'btn-success' : 'btn-outline';
            const rejectClass = myVote === false ? 'btn-danger' : 'btn-outline';
            actions = `
                <button class="btn ${approveClass} btn-small" onclick="voteProposal('${a.id}', true)"
                    ${myVote === true ? 'disabled' : ''}>Approve${myVote === true ? 'd' : ''}</button>
                <button class="btn ${rejectClass} btn-small" onclick="voteProposal('${a.id}', false)"
                    ${myVote === false ? 'disabled' : ''}>Reject${myVote === false ? 'ed' : ''}</button>
            `;
            if (a.proposed_by === currentUser.id) {
                actions += ` <button class="btn btn-secondary btn-small" onclick="withdrawProposal('${a.id}')">Withdraw</button>`;
            }
        }
    }

    const titleText = (a.text || '').trim().slice(0, 72);
    return `<div class="amendment-card ${a.status}">
        <div class="amendment-header">
            <span class="amendment-title">${esc(titleText)}${titleText.length >= 72 ? '…' : ''}</span>
            <span class="amendment-status ${a.status}">${a.status}</span>
        </div>
        <div class="amendment-meta">
            Proposed by ${esc(a.proposer?.display_name || 'Unknown')}
            &middot; ${a.status === 'voting' ? timeLeft : (a.resolved_at ? new Date(a.resolved_at).toLocaleDateString() : '')}
        </div>
        <div class="vote-bar">
            <span style="font-size:0.8rem;font-weight:600;">${countLabel}</span>
            <div class="vote-bar-track">
                <div class="vote-bar-fill" style="width:${pct}%"></div>
                <div class="vote-bar-threshold" style="left:${thresholdPct}%" title="Threshold: ${thresholdPct}%"></div>
            </div>
            <span style="font-size:0.75rem;color:var(--dark-gray);">need ${thresholdPct}%</span>
        </div>
        <details style="margin:0.5rem 0;">
            <summary style="cursor:pointer;font-size:0.85rem;color:var(--primary-color);font-weight:500;">Show proposal</summary>
            <div class="diff-display" style="margin-top:0.5rem;">${esc(a.text || '')}</div>
        </details>
        ${actions ? `<div style="display:flex;gap:0.5rem;margin-top:0.5rem;">${actions}</div>` : ''}
    </div>`;
}

function formatTimeLeft(ms) {
    const days = Math.floor(ms / APP_TIMING.DAY_MS);
    const hours = Math.floor((ms % APP_TIMING.DAY_MS) / APP_TIMING.HOUR_MS);
    if (days > 0) return `${days}d ${hours}h left`;
    const mins = Math.floor((ms % APP_TIMING.HOUR_MS) / APP_TIMING.MINUTE_MS);
    if (hours > 0) return `${hours}h ${mins}m left`;
    return `${mins}m left`;
}

// Live diff preview in the propose amendment modal
function updateAmendmentPreview() {
    const oldText = selectedGroup?.constitution || '';
    const newText = document.getElementById('amendmentEditor')?.value ?? '';
    const preview = document.getElementById('amendmentDiffPreview');
    if (!preview) return;
    const oldDisplay = stripConstitutionTags(oldText);
    const newDisplay = stripConstitutionTags(newText);
    if (oldDisplay === newDisplay) {
        preview.innerHTML = '<span style="color:var(--dark-gray);">No changes yet.</span>';
    } else {
        preview.innerHTML = wordDiff(oldDisplay, newDisplay);
    }
}

async function submitAmendment() {
    if (!selectedGroup) {
        showToast('No group selected', 'error');
        return;
    }
    const title = document.getElementById('amendmentTitle').value.trim();
    const displayText = document.getElementById('amendmentEditor').value;
    const oldText = selectedGroup.constitution || '';

    if (!title) {
        showToast('Please enter a title for the amendment', 'error');
        return;
    }
    if (stripConstitutionTags(displayText) === stripConstitutionTags(oldText)) {
        showToast('No changes detected in the constitution', 'error');
        return;
    }

    let newText;
    try {
        newText = restoreConstitutionTags(displayText, oldText);
    } catch (e) {
        console.error('restoreConstitutionTags failed:', e);
        showToast('Could not prepare amendment text', 'error');
        return;
    }

    const threshold = parseAmendmentThreshold(oldText);
    const periodDays = parseVotingPeriodDays(oldText);

    const amendmentRow = {
        group_id: selectedGroup.id,
        proposed_by: currentUser.id,
        title,
        old_text: oldText,
        new_text: newText,
        threshold
    };

    if (periodDays) {
        const expires = new Date();
        expires.setDate(expires.getDate() + periodDays);
        amendmentRow.expires_at = expires.toISOString();
    }

    const { error } = await db.from('amendments').insert(amendmentRow);

    if (error) { showToast(error.message, 'error'); return; }

    // Log the event for realtime notifications
    await db.rpc('log_group_event', {
        p_group_id: selectedGroup.id,
        p_event_type: 'amendment_proposed',
        p_summary: 'Amendment proposed: ' + title,
        p_metadata: { title }
    });

    const voteDays = periodDays || 7;
    showToast(`Amendment proposed! Members have ${voteDays} day${voteDays === 1 ? '' : 's'} to vote.`, 'success');
    closeModal();
    if (activeTab === 'governance') await loadConstitutionContent();
}

async function submitProposal() {
    if (!selectedGroup) return;
    const proposalText = document.getElementById('proposalEditor').value.trim();
    if (!proposalText) {
        showToast('Please enter your proposal text', 'error');
        return;
    }

    const constitutionText = selectedGroup.constitution || '';
    const threshold = parseAccordThreshold(constitutionText);
    const periodDays = parseVotingPeriodDays(constitutionText);
    const proposalRow = {
        group_id: selectedGroup.id,
        proposed_by: currentUser.id,
        text: proposalText,
        threshold
    };

    if (periodDays) {
        const expires = new Date();
        expires.setDate(expires.getDate() + periodDays);
        proposalRow.expires_at = expires.toISOString();
    }

    const { error } = await db.from('accord_proposals').insert(proposalRow);
    if (error) {
        showToast(error.message, 'error');
        return;
    }

    const voteDays = periodDays || 7;
    showToast(`Proposal submitted! Members have ${voteDays} day${voteDays === 1 ? '' : 's'} to vote.`, 'success');
    closeModal();
    if (activeTab === 'governance') await loadConstitutionContent();
}

async function voteAmendment(amendmentId, approve) {
    const { error } = await db.from('amendment_votes').upsert({
        amendment_id: amendmentId,
        user_id: currentUser.id,
        vote: approve
    }, { onConflict: 'amendment_id,user_id' });

    if (error) { showToast(error.message, 'error'); return; }

    // After an approval vote, check if threshold is now met
    if (approve) {
        const { data, error: resolveError } = await db.rpc('resolve_amendment', { p_amendment_id: amendmentId });
        if (!resolveError && data?.passed) {
            const tally = data.voting_period && data.voter_count != null
                ? `${data.approve_count}/${data.voter_count} voted`
                : `${data.approve_count}/${data.active_members} approved`;
            showToast(`Amendment passed! (${tally}, ${data.ratio}% ≥ ${data.threshold}% needed)`, 'success');
            // Refresh group data since constitution may have changed
            const { data: freshGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
            if (freshGroup) {
                selectedGroup = freshGroup;
                const membership = myGroups.find(m => m.group_id === selectedGroup.id);
                if (membership) membership.groups = freshGroup;
                renderGroupList();
            }
            await loadConstitutionContent();
            return;
        }
    }

    showToast(approve ? 'Voted to approve' : 'Voted to reject', 'info');
    await loadConstitutionContent();
}

async function voteProposal(proposalId, approve) {
    const { error } = await db.from('accord_votes').upsert({
        accord_id: proposalId,
        user_id: currentUser.id,
        vote: approve
    }, { onConflict: 'accord_id,user_id' });

    if (error) {
        showToast(error.message, 'error');
        return;
    }

    if (approve) {
        const { data, error: resolveError } = await db.rpc('resolve_accord', { p_accord_id: proposalId });
        if (!resolveError && data?.passed) {
            const tally = data.voting_period && data.voter_count != null
                ? `${data.approve_count}/${data.voter_count} voted`
                : `${data.approve_count}/${data.active_members} approved`;
            showToast(`Accord adopted! (${tally}, ${data.ratio}% ≥ ${data.threshold}% needed)`, 'success');
            await loadConstitutionContent();
            return;
        }
    }

    showToast(approve ? 'Voted to approve proposal' : 'Voted to reject proposal', 'info');
    await loadConstitutionContent();
}

async function resolveAmendment(amendmentId) {
    const { data, error } = await db.rpc('resolve_amendment', { p_amendment_id: amendmentId });
    if (error) { showToast(error.message, 'error'); return; }

    if (data?.resolved === false) {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members}`;
        showToast(`Not enough votes yet (${tally}, need ${data.threshold}%)`, 'info');
    } else if (data?.passed) {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members} approved`;
        showToast(`Amendment passed! (${tally}, ${data.ratio}% ≥ ${data.threshold}% needed)`, 'success');
        const { data: freshGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
        if (freshGroup) {
            selectedGroup = freshGroup;
            const membership = myGroups.find(m => m.group_id === selectedGroup.id);
            if (membership) membership.groups = freshGroup;
            renderGroupList();
        }
    } else {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members} approved`;
        showToast(`Amendment failed. (${tally}, ${data.ratio}% < ${data.threshold}% needed)`, 'error');
    }
    await loadConstitutionContent();
}

async function resolveProposal(proposalId) {
    const { data, error } = await db.rpc('resolve_accord', { p_accord_id: proposalId });
    if (error) {
        showToast(error.message, 'error');
        return;
    }

    if (data?.resolved === false) {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members}`;
        showToast(`Not enough votes yet (${tally}, need ${data.threshold}%)`, 'info');
    } else if (data?.passed) {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members} approved`;
        showToast(`Accord adopted! (${tally}, ${data.ratio}% ≥ ${data.threshold}% needed)`, 'success');
    } else {
        const tally = data.voting_period && data.voter_count != null
            ? `${data.approve_count}/${data.voter_count} voted`
            : `${data.approve_count}/${data.active_members} approved`;
        showToast(`Accord proposal failed. (${tally}, ${data.ratio}% < ${data.threshold}% needed)`, 'error');
    }
    await loadConstitutionContent();
}

async function withdrawAmendment(amendmentId) {
    console.log('withdrawAmendment called with:', amendmentId);
    try {
        const { data, error } = await db
            .from('amendments')
            .update({ status: 'withdrawn' })
            .eq('id', amendmentId)
            .select()
            .single();

        console.log('withdrawAmendment result:', { data, error });
        if (error) {
            console.error('withdrawAmendment error:', error);
            showToast(error.message, 'error');
            return;
        }
        showToast('Amendment withdrawn', 'info');
        await loadConstitutionContent();
    } catch (e) {
        console.error('withdrawAmendment exception:', e);
        showToast('Error withdrawing amendment: ' + e.message, 'error');
    }
}

async function withdrawProposal(proposalId) {
    try {
        const { error } = await db
            .from('accord_proposals')
            .update({ status: 'withdrawn' })
            .eq('id', proposalId);
        if (error) {
            showToast(error.message, 'error');
            return;
        }
        showToast('Proposal withdrawn', 'info');
        await loadConstitutionContent();
    } catch (e) {
        showToast('Error withdrawing proposal: ' + e.message, 'error');
    }
}

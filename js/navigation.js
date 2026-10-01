// Remember where the contacts list was scrolled to when the user opened a
// contact's detail screen, so we can put them back in the same spot on return.
// The contacts list and contact-details screens are siblings inside
// .main-content and the page itself is what scrolls, so without this the
// detail screen would inherit whatever scrollY the list happened to have.
let _contactsScrollY = 0;

function getContactDetailResumeKeys() {
    if (!currentUser) return null;
    const uid = currentUser.id;
    return {
        wasDetailKey: `fairshare_was_detail_${uid}`,
        homeContactKey: `fairshare_home_contact_${uid}`
    };
}

function getDirectMessageResumeKeys() {
    if (!currentUser) return null;
    const uid = currentUser.id;
    return {
        wasDmKey: `fairshare_was_dm_${uid}`,
        homeDmKey: `fairshare_home_dm_${uid}`
    };
}

// Persist one contact as the user's "home" screen: reopen to contact details
// on next launch if they left the app while viewing that screen. Cleared when
// they return to the contact list or switch to another main tab (profile,
// groups, globe).
function updateContactDetailResumeState(view, arg) {
    const keys = getContactDetailResumeKeys();
    if (!keys) return;
    try {
        if (view === 'contactDetails' && arg) {
            localStorage.setItem(keys.wasDetailKey, '1');
            localStorage.setItem(keys.homeContactKey, arg);
        } else if (view === 'contacts') {
            localStorage.setItem(keys.wasDetailKey, '0');
            localStorage.removeItem(keys.homeContactKey);
        } else {
            localStorage.setItem(keys.wasDetailKey, '0');
            localStorage.removeItem(keys.homeContactKey);
        }
    } catch (_) { /* storage full or unavailable */ }
}

function clearContactDetailResumeState() {
    const keys = getContactDetailResumeKeys();
    if (!keys) return;
    try {
        localStorage.removeItem(keys.wasDetailKey);
        localStorage.removeItem(keys.homeContactKey);
    } catch (_) {}
}

// Persist one 1:1 chat as the user's home screen so relaunch/background
// restore returns them to the same direct-message thread.
function updateDirectMessageResumeState(view, arg) {
    const keys = getDirectMessageResumeKeys();
    if (!keys) return;
    try {
        if (view === 'directMessage' && arg) {
            localStorage.setItem(keys.wasDmKey, '1');
            localStorage.setItem(keys.homeDmKey, arg);
        } else {
            localStorage.setItem(keys.wasDmKey, '0');
            localStorage.removeItem(keys.homeDmKey);
        }
    } catch (_) { /* storage full or unavailable */ }
}

function clearDirectMessageResumeState() {
    const keys = getDirectMessageResumeKeys();
    if (!keys) return;
    try {
        localStorage.removeItem(keys.wasDmKey);
        localStorage.removeItem(keys.homeDmKey);
    } catch (_) {}
}

function readContactDetailResumeContactId() {
    const keys = getContactDetailResumeKeys();
    if (!keys) return null;
    try {
        if (localStorage.getItem(keys.wasDetailKey) !== '1') return null;
        return localStorage.getItem(keys.homeContactKey) || null;
    } catch (_) {
        return null;
    }
}

function readDirectMessageResumeContactId() {
    const keys = getDirectMessageResumeKeys();
    if (!keys) return null;
    try {
        if (localStorage.getItem(keys.wasDmKey) !== '1') return null;
        return localStorage.getItem(keys.homeDmKey) || null;
    } catch (_) {
        return null;
    }
}

function navigateTo(view, arg) {
    if (!currentUser) return;

    const previousMainView = activeMainView;

    if (activeMainView === 'contacts' && view === 'contactDetails') {
        _contactsScrollY = window.scrollY || window.pageYOffset || 0;
    }

    activeMainView = view;

    if (view !== 'groups') {
        document.body.classList.remove('chat-tab-active');
        const main = document.querySelector('.main-content');
        if (main) {
            main.style.height = '';
            main.style.overflow = '';
        }
        if (typeof resetChatLayoutStyles === 'function') resetChatLayoutStyles();
        if (typeof unbindChatViewportListeners === 'function') unbindChatViewportListeners();
    }
    if (view !== 'directMessage') {
        document.body.classList.remove('dm-screen-active');
        if (typeof teardownDirectMessageView === 'function') teardownDirectMessageView();
    }

    const contactsScreen = document.getElementById('contactsScreen');
    const groupsContent = document.getElementById('groupsContent');
    const profileScreen = document.getElementById('profileScreen');
    const contactDetailsScreen = document.getElementById('contactDetailsScreen');
    const directMessageScreen = document.getElementById('directMessageScreen');
    const globeScreen = document.getElementById('globeScreen');

    contactsScreen.classList.add('hidden');
    groupsContent.classList.add('hidden');
    profileScreen.classList.add('hidden');
    if (contactDetailsScreen) contactDetailsScreen.classList.add('hidden');
    if (directMessageScreen) directMessageScreen.classList.add('hidden');
    if (globeScreen) globeScreen.classList.add('hidden');

    switch (view) {
        case 'contacts': {
            contactsScreen.classList.remove('hidden');
            bindContactsSearchInput();
            bindContactsSortButton();
            const targetY = _contactsScrollY;
            // Restore immediately so the existing DOM doesn't flash at the top,
            // then again after the async reload completes in case the rendered
            // height changed.
            window.scrollTo(0, targetY);
            requestAnimationFrame(() => window.scrollTo(0, targetY));
            const p = loadAndRenderContactList();
            if (p && typeof p.then === 'function') {
                p.then(() => window.scrollTo(0, targetY)).catch(() => {});
            }
            break;
        }
        case 'groups':
            groupsContent.classList.remove('hidden');
            if (previousMainView === 'groups' && selectedGroup) showGroupsList(); else renderGroupList();
            if (selectedGroup && typeof restoreChatLayoutIfNeeded === 'function') {
                restoreChatLayoutIfNeeded();
            }
            break;
        case 'profile':
            profileScreen.classList.remove('hidden');
            renderProfileScreen();
            break;
        case 'contactDetails':
            if (contactDetailsScreen) {
                contactDetailsScreen.classList.remove('hidden');
                openContactDetailsScreen(arg);
                // Always start at the hero card. Two passes handle the case
                // where async hydration (selfies, history) bumps page height.
                window.scrollTo(0, 0);
                requestAnimationFrame(() => window.scrollTo(0, 0));
            }
            break;
        case 'directMessage':
            if (directMessageScreen) {
                directMessageScreen.classList.remove('hidden');
                document.body.classList.add('dm-screen-active');
                renderDirectMessageScreen(arg);
                window.scrollTo(0, 0);
                requestAnimationFrame(() => window.scrollTo(0, 0));
            }
            break;
        case 'globe':
            if (globeScreen) {
                globeScreen.classList.remove('hidden');
                window.scrollTo(0, 0);
                if (typeof openGlobeScreen === 'function') openGlobeScreen();
            }
            break;
    }

    updateBottomBarActive(view);

    // Skip redundant contacts → contacts (e.g. showApp right after cold start when
    // activeMainView is already 'contacts') so we do not wipe resume keys from
    // the previous session before readContactDetailResumeContactId runs.
    if (!(view === 'contacts' && previousMainView === 'contacts')) {
        updateContactDetailResumeState(view, arg);
        updateDirectMessageResumeState(view, arg);
    }
}

function updateBottomBarActive(view) {
    document.querySelectorAll('.bottom-bar-btn[data-view]').forEach(btn => {
        // Contact Details is logically a child of the Contacts tab, so keep
        // the Contacts button highlighted while it's open.
        const target = (view === 'contactDetails' || view === 'directMessage') ? 'contacts' : view;
        btn.classList.toggle('active', btn.dataset.view === target);
    });
}

// ---- Header avatar dropdown menu --------------------------------------------

function toggleHeaderMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('headerMenu');
    const btn = document.getElementById('headerAvatarBtn');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
        menu.classList.remove('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        // Defer attaching the outside-click listener so this same click
        // doesn't immediately close the menu we just opened.
        setTimeout(() => {
            document.addEventListener('click', closeHeaderMenuOnOutsideClick);
        }, 0);
    } else {
        closeHeaderMenu();
    }
}

function closeHeaderMenu() {
    const menu = document.getElementById('headerMenu');
    const btn = document.getElementById('headerAvatarBtn');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeHeaderMenuOnOutsideClick);
}

function closeHeaderMenuOnOutsideClick(e) {
    const menu = document.getElementById('headerMenu');
    const btn = document.getElementById('headerAvatarBtn');
    if (!menu) return;
    if (menu.contains(e.target)) return;
    if (btn && btn.contains(e.target)) return;
    closeHeaderMenu();
}

function onHeaderMenuClick(action) {
    closeHeaderMenu();
    if (action === 'profile' || action === 'preferences') {
        navigateTo('profile');
    } else if (action === 'logout') {
        if (typeof logout === 'function') logout();
    }
}

(() => {
    let toastContainer;

    const getToastContainer = () => {
        if (toastContainer) return toastContainer;

        toastContainer = document.createElement('div');
        toastContainer.className = 'site-notification-container';
        toastContainer.setAttribute('aria-live', 'polite');
        toastContainer.setAttribute('aria-atomic', 'true');
        document.body.appendChild(toastContainer);
        return toastContainer;
    };

    const showToast = (message, duration = 2000) => {
        const toast = document.createElement('div');
        toast.className = 'site-notification';
        const shownAt = performance.now();

        const messageText = document.createElement('span');
        messageText.className = 'site-notification-message';
        messageText.textContent = String(message ?? '');

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'site-notification-close';
        closeButton.setAttribute('aria-label', 'Tutup notifikasi');
        closeButton.textContent = '×';

        const dismissOnPageClick = () => {
            if (performance.now() - shownAt > 100) removeToast();
        };

        const removeToast = () => {
            toast.classList.add('is-closing');
            document.removeEventListener('click', dismissOnPageClick);
            window.setTimeout(() => toast.remove(), 180);
        };

        closeButton.addEventListener('click', removeToast);
        document.addEventListener('click', dismissOnPageClick);
        toast.append(messageText, closeButton);
        getToastContainer().appendChild(toast);
        window.setTimeout(removeToast, duration);
    };

    const showConfirm = message => new Promise(resolve => {
        const backdrop = document.createElement('div');
        backdrop.className = 'site-confirm-backdrop';
        backdrop.setAttribute('role', 'presentation');

        const dialog = document.createElement('section');
        dialog.className = 'site-confirm-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Konfirmasi');

        const title = document.createElement('h2');
        title.className = 'site-confirm-title';
        title.textContent = 'Konfirmasi';

        const messageText = document.createElement('p');
        messageText.className = 'site-confirm-message';
        messageText.textContent = String(message ?? '');

        const actions = document.createElement('div');
        actions.className = 'site-confirm-actions';

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'site-confirm-button site-confirm-cancel';
        cancelButton.textContent = 'Batal';

        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'site-confirm-button site-confirm-submit';
        confirmButton.textContent = 'Oke';

        const close = confirmed => {
            backdrop.classList.add('is-closing');
            window.setTimeout(() => backdrop.remove(), 160);
            resolve(confirmed);
        };

        cancelButton.addEventListener('click', () => close(false));
        confirmButton.addEventListener('click', () => close(true));
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) close(false);
        });

        actions.append(cancelButton, confirmButton);
        dialog.append(title, messageText, actions);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        confirmButton.focus();
    });

    window.CustomPopup = { show: showToast };
    window.showToast = showToast;
    window.showConfirm = showConfirm;
    window.alert = showToast;
})();

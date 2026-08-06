__license__ = 'AGPL v3'
__copyright__ = '2026, Bilingify LLC'

from qt.core import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QProgressBar,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from calibre.gui2 import error_dialog

from calibre_plugins.readest.api import ReadestAPIError
from calibre_plugins.readest.worker import (
    CHECK_LABELS,
    STATUS_LABELS,
    PushWorker,
    StatusWorker,
)



class LoginDialog(QDialog):
    """Email and password against Better Auth."""

    def __init__(self, parent, client):
        QDialog.__init__(self, parent)
        self.client = client
        self.user = None

        self.setWindowTitle('Log in to Readest')
        layout = QVBoxLayout()
        self.setLayout(layout)

        form = QFormLayout()
        self.email_edit = QLineEdit(self)
        self.password_edit = QLineEdit(self)
        self.password_edit.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow('Email:', self.email_edit)
        form.addRow('Password:', self.password_edit)
        layout.addLayout(form)

        self.login_btn = QPushButton('Log in', self)
        self.login_btn.clicked.connect(self.password_login)
        layout.addWidget(self.login_btn)


        self.status_label = QLabel('')
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def password_login(self):
        email = self.email_edit.text().strip()
        password = self.password_edit.text()
        if not email or not password:
            self.status_label.setText('Please enter both email and password.')
            return
        self.status_label.setText('Logging in…')
        self.login_btn.setEnabled(False)
        try:
            self.user = self.client.sign_in_password(email, password)
        except ReadestAPIError as err:
            self.status_label.setText('Login failed: %s' % err)
            self.login_btn.setEnabled(True)
            return
        self.accept()

class _RunDialog(QDialog):
    """Per-book status table for one worker run, modeled on BookFusion's sync log."""

    worker_class = None
    title = ''
    heading = ''
    labels = {}
    failure_title = ''

    def __init__(self, parent, db, book_ids, client, include_custom_columns):
        QDialog.__init__(self, parent)
        self.db = db
        self.marks = {}

        self.setWindowTitle(self.title)
        self.setMinimumSize(520, 380)
        layout = QVBoxLayout()
        self.setLayout(layout)

        count = len(book_ids)
        layout.addWidget(QLabel(self.heading % (count, _plural(count))))

        self.progress_bar = QProgressBar(self)
        self.progress_bar.setRange(0, count)
        layout.addWidget(self.progress_bar)

        self.table = QTableWidget(0, 3, self)
        self.table.setHorizontalHeaderLabels(['Book', 'Status', 'Details'])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setColumnWidth(0, 220)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.table)

        self.summary_label = QLabel('')
        self.summary_label.setWordWrap(True)
        layout.addWidget(self.summary_label)

        self.buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)

        self.worker = self.worker_class(self, db, book_ids, client, include_custom_columns)
        self.worker.progress.connect(self.on_progress)
        self.worker.book_status.connect(self.on_book_status)
        self.worker.done.connect(self.on_done)
        self.worker.start()

    def on_progress(self, done, total):
        self.progress_bar.setValue(done)

    def on_book_status(self, book_id, status, detail):
        title = self.db.field_for('title', book_id) or 'Unknown'
        row = self.table.rowCount()
        self.table.insertRow(row)
        self.table.setItem(row, 0, QTableWidgetItem(title))
        self.table.setItem(row, 1, QTableWidgetItem(self.labels.get(status, status)))
        self.table.setItem(row, 2, QTableWidgetItem(detail))
        self.table.scrollToBottom()

    def on_done(self, ok, message):
        self.progress_bar.setValue(self.progress_bar.maximum())
        self.summary_label.setText(message)
        self.buttons.setStandardButtons(QDialogButtonBox.StandardButton.Close)
        # Read on the GUI thread once the worker is finished, so ui.py can
        # apply them to the library view.
        self.marks = dict(self.worker.marks)
        if not ok and self.table.rowCount() == 0:
            error_dialog(self, self.failure_title, message, show=True)

    def reject(self):
        if self.worker.isRunning():
            self.worker.cancel()
            self.summary_label.setText('Canceling…')
            return
        QDialog.reject(self)


class PushDialog(_RunDialog):
    worker_class = PushWorker
    title = 'Push to Readest'
    heading = 'Pushing %d %s to your Readest library…'
    labels = STATUS_LABELS
    failure_title = 'Push to Readest failed'


class StatusDialog(_RunDialog):
    worker_class = StatusWorker
    title = 'Readest status'
    heading = 'Checking %d %s against your Readest library…'
    labels = CHECK_LABELS
    failure_title = 'Readest status check failed'


def _plural(count):
    return 'book' if count == 1 else 'books'

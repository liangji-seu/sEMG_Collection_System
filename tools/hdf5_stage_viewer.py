"""
HDF5 Stage Viewer - EMG/IMU采集数据可视化工具 (v2.0)

适配新的H5文件格式：
- 一个Stage一个H5文件
- 文件结构: emg1, emg2, imu1, imu2, prompts/, subject/
- 支持元数据显示（task_id, user_id, stage_name, category等）

功能:
1. 浏览HDF5文件结构（树形视图）
2. 查看数据集的属性和形状
3. 预览数据（EMG显示7位小数精度）
4. 波形图可视化
5. 统计信息面板

使用方法:
    python hdf5_stage_viewer.py
    或
    python hdf5_stage_viewer.py <file.h5>
"""

import sys
import os
import numpy as np
import h5py
from datetime import datetime

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QTreeWidget, QTreeWidgetItem, QTextEdit, QSplitter, QPushButton,
    QFileDialog, QLabel, QSpinBox, QGroupBox, QTabWidget, QTableWidget,
    QTableWidgetItem, QHeaderView, QMessageBox, QStatusBar, QComboBox,
    QCheckBox, QProgressBar, QFrame, QGridLayout, QScrollArea
)
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QColor, QPalette, QBrush

# 尝试导入matplotlib用于波形图
try:
    import matplotlib
    matplotlib.use('Qt5Agg')
    from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
    from matplotlib.figure import Figure
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("警告: matplotlib未安装，波形图功能不可用")


class WaveformWidget(QWidget):
    """波形显示组件"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        
        if HAS_MATPLOTLIB:
            self.figure = Figure(figsize=(10, 4), dpi=100)
            self.canvas = FigureCanvas(self.figure)
            layout.addWidget(self.canvas)
        else:
            label = QLabel("需要安装matplotlib才能显示波形图\npip install matplotlib")
            label.setAlignment(Qt.AlignCenter)
            label.setStyleSheet("color: #888; padding: 50px;")
            layout.addWidget(label)
    
    def plot_emg(self, data, timestamps, title="EMG波形", channels=None):
        """绘制EMG波形"""
        if not HAS_MATPLOTLIB:
            return
        
        self.figure.clear()
        
        if channels is None:
            channels = list(range(min(8, data.shape[1] if len(data.shape) > 1 else 16)))
        
        n_channels = len(channels)
        
        for i, ch in enumerate(channels):
            ax = self.figure.add_subplot(n_channels, 1, i + 1)
            
            if len(data.shape) > 1:
                ch_data = data[:, ch] if data.shape[1] > ch else data[:, 0]
            else:
                ch_data = data
            
            ax.plot(timestamps[:len(ch_data)], ch_data, linewidth=0.5, color=f'C{i % 10}')
            ax.set_ylabel(f'Ch{ch}', fontsize=8)
            ax.tick_params(axis='both', labelsize=7)
            ax.grid(True, alpha=0.3)
            
            if i < n_channels - 1:
                ax.set_xticklabels([])
        
        self.figure.suptitle(title, fontsize=10)
        self.figure.tight_layout()
        self.canvas.draw()
    
    def plot_imu(self, data, timestamps, title="IMU数据"):
        """绘制IMU数据"""
        if not HAS_MATPLOTLIB:
            return
        
        self.figure.clear()
        
        sensors = ['acc', 'gyr', 'mag']
        labels = ['加速度 (m/s²)', '角速度 (°/s)', '磁力 (μT)']
        colors = [['r', 'g', 'b'], ['orange', 'purple', 'cyan'], ['brown', 'pink', 'gray']]
        
        for i, (sensor, label, cols) in enumerate(zip(sensors, labels, colors)):
            ax = self.figure.add_subplot(3, 1, i + 1)
            
            if sensor in data.dtype.names:
                sensor_data = data[sensor]
                for j, axis in enumerate(['X', 'Y', 'Z']):
                    ax.plot(timestamps, sensor_data[:, j], 
                           label=axis, linewidth=0.8, color=cols[j])
                ax.set_ylabel(label, fontsize=8)
                ax.legend(loc='upper right', fontsize=7)
                ax.grid(True, alpha=0.3)
                ax.tick_params(axis='both', labelsize=7)
        
        self.figure.suptitle(title, fontsize=10)
        self.figure.tight_layout()
        self.canvas.draw()


class StatisticsPanel(QFrame):
    """统计信息面板"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()
    
    def init_ui(self):
        self.setFrameStyle(QFrame.StyledPanel)
        self.setStyleSheet("""
            StatisticsPanel {
                background-color: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 8px;
            }
        """)
        
        layout = QGridLayout(self)
        layout.setSpacing(10)
        
        # 创建统计标签
        self.labels = {}
        stats = [
            ('task_id', '任务ID'),
            ('user_id', '用户ID'),
            ('stage_name', 'Stage名称'),
            ('category', '分类'),
            ('created_at', '创建时间'),
            ('emg1_frames', 'EMG1帧数'),
            ('emg2_frames', 'EMG2帧数'),
            # 【修改】4个IMU数据集（每设备2个IMU传感器）
            ('imu1a_frames', 'IMU1A帧数'),
            ('imu1b_frames', 'IMU1B帧数'),
            ('imu2a_frames', 'IMU2A帧数'),
            ('imu2b_frames', 'IMU2B帧数'),
            ('prompts', 'Prompts数'),
            ('duration', '时长'),
        ]
        
        for i, (key, name) in enumerate(stats):
            row = i // 3
            col = (i % 3) * 2
            
            name_label = QLabel(f'{name}:')
            name_label.setStyleSheet('font-weight: bold; color: #495057;')
            
            value_label = QLabel('-')
            value_label.setStyleSheet('color: #212529;')
            value_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
            
            layout.addWidget(name_label, row, col)
            layout.addWidget(value_label, row, col + 1)
            
            self.labels[key] = value_label
    
    def update_stats(self, h5file):
        """更新统计信息"""
        if not h5file:
            return
        
        # 文件属性
        attrs = h5file.attrs
        
        self.labels['task_id'].setText(str(attrs.get('task_id', '-')))
        self.labels['user_id'].setText(str(attrs.get('user_id', '-')))
        self.labels['stage_name'].setText(str(attrs.get('stage_name', '-')))
        
        # 分类信息
        cat1 = str(attrs.get('category1', ''))
        cat2 = str(attrs.get('category2', ''))
        cat4 = str(attrs.get('category4', ''))
        self.labels['category'].setText(f'{cat1}/{cat2}/{cat4}')
        
        self.labels['created_at'].setText(str(attrs.get('created_at', '-'))[:19])
        
        # 数据统计：兼容原始/同步后的命名，只读取 shape 和时间端点。
        def _first_dataset(names):
            for name in names:
                if name in h5file and isinstance(h5file[name], h5py.Dataset):
                    return h5file[name]
            return None

        emg1_ds = _first_dataset(['emg1_2khz_adc', 'emg1_2khz', 'emg1_250hz_adc', 'emg1_250hz', 'emg1'])
        emg2_ds = _first_dataset(['emg2_2khz_adc', 'emg2_2khz', 'emg2_250hz_adc', 'emg2_250hz', 'emg2'])
        emg1_frames = emg1_ds.shape[0] if emg1_ds is not None else 0
        emg2_frames = emg2_ds.shape[0] if emg2_ds is not None else 0
        # 【修改】4个IMU数据集（每设备2个IMU传感器）
        imu1a_frames = h5file['imu1a_ble'].shape[0] if 'imu1a_ble' in h5file else 0
        imu1b_frames = h5file['imu1b_ble'].shape[0] if 'imu1b_ble' in h5file else 0
        imu2a_frames = h5file['imu2a_ble'].shape[0] if 'imu2a_ble' in h5file else 0
        imu2b_frames = h5file['imu2b_ble'].shape[0] if 'imu2b_ble' in h5file else 0

        self.labels['emg1_frames'].setText(f'{emg1_frames:,}')
        self.labels['emg2_frames'].setText(f'{emg2_frames:,}')
        self.labels['imu1a_frames'].setText(f'{imu1a_frames:,}')
        self.labels['imu1b_frames'].setText(f'{imu1b_frames:,}')
        self.labels['imu2a_frames'].setText(f'{imu2a_frames:,}')
        self.labels['imu2b_frames'].setText(f'{imu2b_frames:,}')
        
        # Prompts
        prompts_count = 0
        if 'prompts' in h5file and 'names' in h5file['prompts']:
            prompts_count = h5file['prompts']['names'].shape[0]
        self.labels['prompts'].setText(str(prompts_count))
        
        # 优先使用真实 time 字段首尾；无 time 时才按命名采样率估算。
        duration_sec = self._dataset_duration(emg1_ds, emg1_frames)
        if duration_sec is None:
            duration_sec = self._dataset_duration(emg2_ds, emg2_frames)
        if duration_sec is None and emg1_frames > 0:
            rate = 250.0 if emg1_ds is not None and '250hz' in str(emg1_ds.name).lower() else 2000.0
            duration_sec = max(0.0, (emg1_frames - 1) / rate)
        if duration_sec is not None:
            minutes = int(duration_sec // 60)
            seconds = duration_sec % 60
            self.labels['duration'].setText(f'{minutes}分{seconds:.1f}秒')
        else:
            self.labels['duration'].setText('-')

    @staticmethod
    def _dataset_duration(dataset, length=None):
        """Read at most two records to derive a real timestamp duration."""
        if dataset is None or (length if length is not None else len(dataset)) <= 0:
            return None
        names = dataset.dtype.names or ()
        if 'time' not in names:
            return None
        try:
            time_field = dataset.fields('time')
            first = float(time_field[0])
            last = float(time_field[-1])
            return max(0.0, last - first)
        except Exception:
            return None


class HDF5StageViewer(QMainWindow):
    """HDF5 Stage文件查看器"""
    
    def __init__(self, file_path=None):
        super().__init__()
        self.file_path = file_path
        self.h5file = None
        self.preview_count = 20  # 默认预览条数
        self.emg_precision = 7   # EMG数据小数精度
        
        self.init_ui()
        
        if file_path and os.path.exists(file_path):
            self.load_file(file_path)
    
    def init_ui(self):
        """初始化UI"""
        self.setWindowTitle('HDF5 Stage Viewer - EMG/IMU数据可视化')
        self.setGeometry(50, 50, 1600, 1000)
        
        # 主布局
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setSpacing(10)
        
        # ========== 顶部工具栏 ==========
        toolbar = self._create_toolbar()
        main_layout.addLayout(toolbar)
        
        # ========== 统计信息面板 ==========
        self.stats_panel = StatisticsPanel()
        main_layout.addWidget(self.stats_panel)
        
        # ========== 主内容区域（分割器） ==========
        main_splitter = QSplitter(Qt.Horizontal)
        
        # 左侧：文件结构树
        left_panel = self._create_left_panel()
        main_splitter.addWidget(left_panel)
        
        # 右侧：数据预览（标签页）
        right_panel = self._create_right_panel()
        main_splitter.addWidget(right_panel)
        
        main_splitter.setSizes([350, 1250])
        main_layout.addWidget(main_splitter)
        
        # ========== 状态栏 ==========
        self.statusBar = QStatusBar()
        self.setStatusBar(self.statusBar)
        self.statusBar.showMessage('就绪 - 请打开HDF5文件')
        
        # 应用样式
        self._apply_styles()
    
    def _create_toolbar(self):
        """创建工具栏"""
        toolbar = QHBoxLayout()
        
        # 打开文件按钮
        self.btn_open = QPushButton('📂 打开文件')
        self.btn_open.clicked.connect(self.open_file_dialog)
        self.btn_open.setMinimumWidth(100)
        toolbar.addWidget(self.btn_open)
        
        # 文件路径显示
        self.label_file = QLabel('未加载文件')
        self.label_file.setStyleSheet('color: #666; padding: 5px 10px; background: #f0f0f0; border-radius: 4px;')
        toolbar.addWidget(self.label_file, 1)
        
        # 分隔
        toolbar.addSpacing(20)
        
        # 预览条数设置
        toolbar.addWidget(QLabel('预览条数:'))
        self.spin_preview = QSpinBox()
        self.spin_preview.setRange(5, 500)
        self.spin_preview.setValue(20)
        self.spin_preview.valueChanged.connect(self.on_preview_count_changed)
        toolbar.addWidget(self.spin_preview)
        
        # EMG精度设置
        toolbar.addWidget(QLabel('EMG精度:'))
        self.spin_precision = QSpinBox()
        self.spin_precision.setRange(2, 10)
        self.spin_precision.setValue(7)
        self.spin_precision.setToolTip('EMG数据显示的小数位数')
        self.spin_precision.valueChanged.connect(self.on_precision_changed)
        toolbar.addWidget(self.spin_precision)
        
        # 刷新按钮
        self.btn_refresh = QPushButton('🔄 刷新')
        self.btn_refresh.clicked.connect(self.refresh_view)
        toolbar.addWidget(self.btn_refresh)
        
        return toolbar
    
    def _create_left_panel(self):
        """创建左侧面板"""
        left_panel = QGroupBox('📁 文件结构')
        left_layout = QVBoxLayout(left_panel)
        
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(['名称', '类型', '形状/值'])
        self.tree.setColumnWidth(0, 180)
        self.tree.setColumnWidth(1, 80)
        self.tree.setColumnWidth(2, 100)
        self.tree.itemClicked.connect(self.on_tree_item_clicked)
        self.tree.setAlternatingRowColors(True)
        left_layout.addWidget(self.tree)
        
        return left_panel
    
    def _create_right_panel(self):
        """创建右侧面板"""
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        
        # 选中项信息
        self.info_group = QGroupBox('ℹ️ 选中项信息')
        info_layout = QVBoxLayout(self.info_group)
        self.label_info = QTextEdit()
        self.label_info.setReadOnly(True)
        self.label_info.setMaximumHeight(120)
        self.label_info.setFont(QFont('Consolas', 9))
        info_layout.addWidget(self.label_info)
        right_layout.addWidget(self.info_group)
        
        # 数据预览标签页
        self.tabs = QTabWidget()
        
        # 表格视图
        self.table = QTableWidget()
        self.table.setAlternatingRowColors(True)
        self.table.setFont(QFont('Consolas', 9))
        self.tabs.addTab(self.table, '📊 表格视图')
        
        # 文本视图
        self.text_preview = QTextEdit()
        self.text_preview.setReadOnly(True)
        self.text_preview.setFont(QFont('Consolas', 9))
        self.tabs.addTab(self.text_preview, '📝 文本视图')
        
        # 波形图视图
        self.waveform = WaveformWidget()
        self.tabs.addTab(self.waveform, '📈 波形图')
        
        right_layout.addWidget(self.tabs)
        
        return right_panel
    
    def _apply_styles(self):
        """应用样式"""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #f5f6fa;
            }
            QGroupBox {
                font-weight: bold;
                border: 1px solid #dcdde1;
                border-radius: 6px;
                margin-top: 12px;
                padding-top: 10px;
                background-color: white;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 12px;
                padding: 0 8px;
                color: #2c3e50;
            }
            QPushButton {
                padding: 8px 16px;
                border-radius: 5px;
                background-color: #3498db;
                color: white;
                border: none;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #2980b9;
            }
            QPushButton:pressed {
                background-color: #1f618d;
            }
            QTreeWidget {
                border: 1px solid #ddd;
                border-radius: 4px;
                background-color: white;
            }
            QTreeWidget::item:selected {
                background-color: #3498db;
                color: white;
            }
            QTableWidget {
                border: 1px solid #ddd;
                gridline-color: #eee;
                background-color: white;
            }
            QTableWidget::item:selected {
                background-color: #3498db;
                color: white;
            }
            QHeaderView::section {
                background-color: #ecf0f1;
                padding: 6px;
                border: 1px solid #ddd;
                font-weight: bold;
            }
            QTextEdit {
                border: 1px solid #ddd;
                border-radius: 4px;
                background-color: #fafafa;
            }
            QTabWidget::pane {
                border: 1px solid #ddd;
                border-radius: 4px;
                background-color: white;
            }
            QTabBar::tab {
                padding: 8px 16px;
                margin-right: 2px;
                background-color: #ecf0f1;
                border: 1px solid #ddd;
                border-bottom: none;
                border-top-left-radius: 4px;
                border-top-right-radius: 4px;
            }
            QTabBar::tab:selected {
                background-color: white;
                border-bottom: 1px solid white;
            }
            QSpinBox {
                padding: 5px;
                border: 1px solid #ddd;
                border-radius: 4px;
            }
        """)
    
    def open_file_dialog(self):
        """打开文件对话框"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, '选择HDF5文件', '', 'HDF5 Files (*.h5 *.hdf5);;All Files (*)'
        )
        if file_path:
            self.load_file(file_path)
    
    def load_file(self, file_path):
        """加载HDF5文件"""
        try:
            # 关闭之前的文件
            if self.h5file:
                self.h5file.close()
            
            self.file_path = file_path
            self.h5file = h5py.File(file_path, 'r')
            
            # 更新文件路径显示
            filename = os.path.basename(file_path)
            self.label_file.setText(f'📁 {filename}')
            self.label_file.setToolTip(file_path)
            self.label_file.setStyleSheet('color: #27ae60; padding: 5px 10px; background: #e8f8f5; border-radius: 4px; font-weight: bold;')
            
            # 更新UI
            self.build_tree()
            self.stats_panel.update_stats(self.h5file)
            self.show_file_summary()
            
            self.statusBar.showMessage(f'已加载: {file_path}')
            
        except Exception as e:
            QMessageBox.critical(self, '错误', f'无法加载文件:\n{str(e)}')
            self.statusBar.showMessage(f'加载失败: {str(e)}')
    
    def build_tree(self):
        """构建文件结构树"""
        self.tree.clear()
        
        if not self.h5file:
            return
        
        # 根节点
        root = QTreeWidgetItem(self.tree, [
            '📁 ' + os.path.basename(self.file_path), 
            'File', 
            ''
        ])
        root.setData(0, Qt.UserRole, '/')
        
        # 添加文件属性
        if self.h5file.attrs:
            attrs_item = QTreeWidgetItem(root, ['📋 元数据', 'Attributes', f'{len(self.h5file.attrs)} 项'])
            attrs_item.setData(0, Qt.UserRole, '/@attrs')
            
            for key in self.h5file.attrs:
                val = self.h5file.attrs[key]
                val_str = str(val)[:40] + '...' if len(str(val)) > 40 else str(val)
                attr_item = QTreeWidgetItem(attrs_item, [f'  {key}', type(val).__name__, val_str])
                attr_item.setData(0, Qt.UserRole, f'/@attr:{key}')
        
        # 遍历文件内容
        def add_items(parent_item, h5_group, path=''):
            for key in h5_group:
                item_path = f'{path}/{key}'
                obj = h5_group[key]
                
                if isinstance(obj, h5py.Group):
                    # 组 - 选择图标
                    if key == 'prompts':
                        icon = '🏷️'
                    elif key == 'subject':
                        icon = '👤'
                    else:
                        icon = '📂'
                    
                    group_item = QTreeWidgetItem(parent_item, [f'{icon} {key}', 'Group', f'{len(obj)} 项'])
                    group_item.setData(0, Qt.UserRole, item_path)
                    
                    # 组属性
                    if obj.attrs:
                        g_attrs = QTreeWidgetItem(group_item, ['📋 属性', 'Attrs', f'{len(obj.attrs)} 项'])
                        g_attrs.setData(0, Qt.UserRole, f'{item_path}/@attrs')
                    
                    # 递归添加子项
                    add_items(group_item, obj, item_path)
                    
                elif isinstance(obj, h5py.Dataset):
                    # 数据集 - 选择图标
                    if 'emg' in key.lower():
                        icon = '📈'
                    elif 'imu' in key.lower():
                        icon = '🔄'
                    elif 'time' in key.lower():
                        icon = '⏱️'
                    elif 'name' in key.lower():
                        icon = '🏷️'
                    else:
                        icon = '📊'
                    
                    shape_str = str(obj.shape)
                    ds_item = QTreeWidgetItem(parent_item, [f'{icon} {key}', str(obj.dtype)[:15], shape_str])
                    ds_item.setData(0, Qt.UserRole, item_path)
        
        add_items(root, self.h5file)
        
        # 展开节点
        root.setExpanded(True)
        for i in range(root.childCount()):
            root.child(i).setExpanded(True)
    
    def show_file_summary(self):
        """显示文件摘要"""
        if not self.h5file:
            return
        
        summary = []
        summary.append('═' * 60)
        summary.append('                    📋 文件摘要')
        summary.append('═' * 60)
        
        # 文件属性
        attrs = self.h5file.attrs
        summary.append(f'\n📌 Stage: {attrs.get("stage_name", "-")}')
        summary.append(f'📌 任务: {attrs.get("task_id", "-")}')
        summary.append(f'📌 用户: {attrs.get("user_id", "-")}')
        summary.append(f'📌 分类: {attrs.get("category1", "-")}/{attrs.get("category2", "-")}/{attrs.get("category4", "-")}')
        summary.append(f'📌 创建: {str(attrs.get("created_at", "-"))[:19]}')
        
        # 数据统计
        summary.append('\n' + '-' * 40)
        summary.append('📊 数据统计:')
        
        if 'emg1' in self.h5file:
            summary.append(f'  • EMG1: {self.h5file["emg1"].shape[0]:,} 帧')
        if 'emg2' in self.h5file:
            summary.append(f'  • EMG2: {self.h5file["emg2"].shape[0]:,} 帧')
        if 'imu1' in self.h5file:
            summary.append(f'  • IMU1: {self.h5file["imu1"].shape[0]:,} 帧')
        if 'imu2' in self.h5file:
            summary.append(f'  • IMU2: {self.h5file["imu2"].shape[0]:,} 帧')
        
        if 'prompts' in self.h5file and 'names' in self.h5file['prompts']:
            summary.append(f'  • Prompts: {self.h5file["prompts"]["names"].shape[0]} 条')
        
        self.label_info.setText('\n'.join(summary))
        self.text_preview.setText('\n'.join(summary))
    
    def on_tree_item_clicked(self, item, column):
        """树节点点击事件"""
        path = item.data(0, Qt.UserRole)
        if not path:
            return
        
        self.show_item_details(path)
    
    def show_item_details(self, path):
        """显示选中项的详细信息"""
        if not self.h5file:
            return
        
        try:
            # 处理属性路径
            if '/@attr:' in path:
                base_path, attr_name = path.split('/@attr:')
                if base_path == '':
                    attrs = self.h5file.attrs
                else:
                    attrs = self.h5file[base_path].attrs
                self.show_attribute(attr_name, attrs[attr_name])
                return
            
            if path.endswith('/@attrs'):
                base_path = path.replace('/@attrs', '')
                if base_path == '':
                    self.show_attributes(self.h5file.attrs, '文件元数据')
                else:
                    self.show_attributes(self.h5file[base_path].attrs, f'{base_path} 属性')
                return
            
            if path == '/':
                self.show_file_summary()
                return
            
            obj = self.h5file[path]
            
            if isinstance(obj, h5py.Group):
                self.show_group_info(path, obj)
            elif isinstance(obj, h5py.Dataset):
                self.show_dataset_preview(path, obj)
                
        except Exception as e:
            self.label_info.setText(f'错误: {str(e)}')
            self.text_preview.setText(f'无法显示: {path}\n错误: {str(e)}')
    
    def show_attributes(self, attrs, title):
        """显示属性列表"""
        info = [f'【{title}】', '-' * 50]
        for key in attrs:
            val = attrs[key]
            info.append(f'{key}: {val}')
        
        self.label_info.setText('\n'.join(info))
        
        # 表格显示
        self.table.clear()
        self.table.setRowCount(len(attrs))
        self.table.setColumnCount(3)
        self.table.setHorizontalHeaderLabels(['属性名', '类型', '值'])
        
        for i, key in enumerate(attrs):
            val = attrs[key]
            self.table.setItem(i, 0, QTableWidgetItem(str(key)))
            self.table.setItem(i, 1, QTableWidgetItem(type(val).__name__))
            self.table.setItem(i, 2, QTableWidgetItem(str(val)))
        
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.text_preview.setText('\n'.join(info))
    
    def show_attribute(self, name, value):
        """显示单个属性"""
        info = f'属性: {name}\n类型: {type(value).__name__}\n值: {value}'
        self.label_info.setText(info)
        self.text_preview.setText(info)
    
    def show_group_info(self, path, group):
        """显示组信息"""
        info = [f'【组: {path}】', '-' * 50]
        info.append(f'子项数量: {len(group)}')
        info.append(f'属性数量: {len(group.attrs)}')
        info.append('')
        info.append('子项列表:')
        for key in group:
            obj = group[key]
            if isinstance(obj, h5py.Group):
                info.append(f'  📂 {key} (Group)')
            else:
                info.append(f'  📊 {key} {obj.shape} {obj.dtype}')
        
        self.label_info.setText('\n'.join(info))
        self.text_preview.setText('\n'.join(info))
        
        # 清空表格
        self.table.clear()
        self.table.setRowCount(0)
    
    def show_dataset_preview(self, path, dataset):
        """显示数据集预览"""
        n = min(self.preview_count, dataset.shape[0]) if dataset.shape else 0
        
        # 信息面板
        info = [
            f'【数据集: {path}】',
            '-' * 50,
            f'形状: {dataset.shape}',
            f'类型: {dataset.dtype}',
            f'大小: {dataset.size:,} 元素',
            f'压缩: {dataset.compression or "无"}',
            f'分块: {dataset.chunks}',
        ]
        
        if dataset.attrs:
            info.append('')
            info.append('属性:')
            for key in dataset.attrs:
                info.append(f'  {key}: {dataset.attrs[key]}')
        
        self.label_info.setText('\n'.join(info))
        
        # 根据数据类型选择显示方式
        if n == 0:
            self.text_preview.setText('数据集为空')
            self.table.clear()
            return
        
        data = dataset[:n]
        
        # 判断数据类型并格式化显示
        if 'emg' in path.lower() and dataset.dtype.names:
            self.show_emg_data(path, data, dataset.dtype, dataset)
        elif 'imu' in path.lower() and dataset.dtype.names:
            self.show_imu_data(path, data, dataset.dtype, dataset)
        elif 'prompts' in path.lower():
            self.show_prompt_data(path, data)
        else:
            self.show_generic_data(path, data)
    
    def show_emg_data(self, path, data, dtype, full_dataset):
        """显示EMG数据（7位小数精度）"""
        precision = self.emg_precision
        text_lines = [
            f'【{path} - EMG数据预览 (前{len(data)}帧)】',
            f'精度: {precision}位小数',
            '═' * 100
        ]

        # 表格设置
        self.table.clear()
        self.table.setRowCount(len(data))

        # EMG有channels和time字段，可能还有frame_id和sd_frame_id
        if 'channels' in dtype.names:
            n_channels = data['channels'].shape[1] if len(data['channels'].shape) > 1 else 16

            # 构建表头：帧序号 + frame_id + sd_frame_id + 通道数据 + 时间戳
            headers = ['帧序号']
            has_frame_id = 'frame_id' in dtype.names
            has_sd_frame_id = 'sd_frame_id' in dtype.names

            if has_frame_id:
                headers.append('BLE帧号')
            if has_sd_frame_id:
                headers.append('SD卡帧号')

            headers += [f'Ch{i}' for i in range(n_channels)]
            headers.append('时间戳')

            self.table.setColumnCount(len(headers))
            self.table.setHorizontalHeaderLabels(headers)

            for i, row in enumerate(data):
                col = 0

                # 帧序号
                item = QTableWidgetItem(str(i))
                item.setTextAlignment(Qt.AlignCenter)
                self.table.setItem(i, col, item)
                col += 1

                # BLE帧号
                if has_frame_id:
                    item = QTableWidgetItem(str(row['frame_id']))
                    item.setTextAlignment(Qt.AlignCenter)
                    item.setBackground(QColor(230, 245, 255))  # 浅蓝色背景
                    self.table.setItem(i, col, item)
                    col += 1

                # SD卡帧号
                if has_sd_frame_id:
                    item = QTableWidgetItem(str(row['sd_frame_id']))
                    item.setTextAlignment(Qt.AlignCenter)
                    item.setBackground(QColor(255, 245, 230))  # 浅橙色背景
                    self.table.setItem(i, col, item)
                    col += 1

                # 通道数据（使用指定精度）
                channels = row['channels']
                for j, val in enumerate(channels):
                    item = QTableWidgetItem(f'{val:.{precision}f}')
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                    # 根据值设置背景色
                    if abs(val) > 100:
                        item.setBackground(QColor(255, 230, 230))  # 浅红
                    self.table.setItem(i, col + j, item)

                # 时间戳
                row_time = float(row['time']) if 'time' in dtype.names else float(i)
                item = QTableWidgetItem(f'{row_time:.9f}')
                item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                self.table.setItem(i, col + n_channels, item)

                # 文本预览（显示前8个通道）
                ch_str = ', '.join([f'{v:.{precision}f}' for v in channels[:8]])
                if n_channels > 8:
                    ch_str += ', ...'

                frame_info = ''
                if has_frame_id:
                    frame_info += f' BLE={row["frame_id"]}'
                if has_sd_frame_id:
                    frame_info += f' SD={row["sd_frame_id"]}'

                text_lines.append(f'帧{i:5d}:{frame_info} [{ch_str}] t={row_time:.9f}')

        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.text_preview.setText('\n'.join(text_lines))

        # 绘制波形图
        if HAS_MATPLOTLIB and full_dataset.shape[0] > 0:
            # 取更多数据用于波形图
            plot_n = min(5000, full_dataset.shape[0])
            plot_data = full_dataset[:plot_n]
            channels_data = plot_data['channels']
            if 'time' in plot_data.dtype.names:
                timestamps = np.asarray(plot_data['time'], dtype=np.float64)
            else:
                rate = float(full_dataset.attrs.get('sample_rate',
                            250 if '250hz' in path.lower() else 2000))
                timestamps = np.arange(plot_n, dtype=np.float64) / max(rate, 1.0)
            self.waveform.plot_emg(channels_data, timestamps, f'{path} 波形 (前{plot_n}帧)')
    
    def show_imu_data(self, path, data, dtype, full_dataset):
        """显示IMU数据"""
        text_lines = [f'【{path} - IMU数据预览 (前{len(data)}帧)】', '═' * 100]

        # 表格设置
        self.table.clear()
        self.table.setRowCount(len(data))

        # 检查是否有帧号字段
        has_frame_id = 'frame_id' in dtype.names
        has_sd_frame_id = 'sd_frame_id' in dtype.names

        # 构建表头
        headers = ['帧序号']
        if has_frame_id:
            headers.append('BLE帧号')
        if has_sd_frame_id:
            headers.append('SD卡帧号')
        headers += ['Acc_X', 'Acc_Y', 'Acc_Z', 'Gyr_X', 'Gyr_Y', 'Gyr_Z', 'Mag_X', 'Mag_Y', 'Mag_Z', '时间戳']

        self.table.setColumnCount(len(headers))
        self.table.setHorizontalHeaderLabels(headers)

        for i, row in enumerate(data):
            col = 0

            # 帧序号
            item = QTableWidgetItem(str(i))
            item.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(i, col, item)
            col += 1

            # BLE帧号
            if has_frame_id:
                item = QTableWidgetItem(str(row['frame_id']))
                item.setTextAlignment(Qt.AlignCenter)
                item.setBackground(QColor(230, 245, 255))  # 浅蓝色背景
                self.table.setItem(i, col, item)
                col += 1

            # SD卡帧号
            if has_sd_frame_id:
                item = QTableWidgetItem(str(row['sd_frame_id']))
                item.setTextAlignment(Qt.AlignCenter)
                item.setBackground(QColor(255, 245, 230))  # 浅橙色背景
                self.table.setItem(i, col, item)
                col += 1

            # 传感器数据
            for sensor in ['acc', 'gyr', 'mag']:
                if sensor in dtype.names:
                    for j, val in enumerate(row[sensor]):
                        item = QTableWidgetItem(f'{val:.6f}')
                        item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                        self.table.setItem(i, col, item)
                        col += 1

            # 时间戳
            if 'time' in dtype.names:
                item = QTableWidgetItem(f'{float(row["time"]):.9f}')
                item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                self.table.setItem(i, col, item)

            # 文本预览
            parts = []
            if has_frame_id:
                parts.append(f'BLE={row["frame_id"]}')
            if has_sd_frame_id:
                parts.append(f'SD={row["sd_frame_id"]}')
            if 'acc' in dtype.names:
                parts.append(f'Acc=[{row["acc"][0]:8.4f}, {row["acc"][1]:8.4f}, {row["acc"][2]:8.4f}]')
            if 'gyr' in dtype.names:
                parts.append(f'Gyr=[{row["gyr"][0]:8.4f}, {row["gyr"][1]:8.4f}, {row["gyr"][2]:8.4f}]')
            if 'time' in dtype.names:
                parts.append(f't={float(row["time"]):.9f}')
            text_lines.append(f'帧{i:5d}: {" ".join(parts)}')

        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.text_preview.setText('\n'.join(text_lines))

        # 绘制波形图
        if HAS_MATPLOTLIB and full_dataset.shape[0] > 0:
            plot_n = min(2000, full_dataset.shape[0])
            plot_data = full_dataset[:plot_n]
            if 'time' in plot_data.dtype.names:
                timestamps = np.asarray(plot_data['time'], dtype=np.float64)
            else:
                rate = float(full_dataset.attrs.get('sample_rate', 100.0))
                timestamps = np.arange(plot_n, dtype=np.float64) / max(rate, 1.0)
            self.waveform.plot_imu(plot_data, timestamps, f'{path} IMU数据 (前{plot_n}帧)')
    
    def show_prompt_data(self, path, data):
        """显示Prompt数据"""
        text_lines = [f'【{path} - Prompt数据预览 (前{len(data)}条)】', '═' * 80]
        
        self.table.clear()
        self.table.setRowCount(len(data))
        self.table.setColumnCount(2)
        self.table.setHorizontalHeaderLabels(['序号', '值'])
        
        for i, val in enumerate(data):
            self.table.setItem(i, 0, QTableWidgetItem(str(i)))
            
            # 处理不同类型的值
            if isinstance(val, bytes):
                val_str = val.decode('utf-8', errors='replace')
            elif isinstance(val, np.floating):
                val_str = f'{val:.9f}'
            else:
                val_str = str(val)
            
            self.table.setItem(i, 1, QTableWidgetItem(val_str))
            text_lines.append(f'{i:4d}: {val_str}')
        
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.text_preview.setText('\n'.join(text_lines))
    
    def show_generic_data(self, path, data):
        """显示通用数据"""
        precision = self.emg_precision
        text_lines = [f'【{path} - 数据预览 (前{len(data)}条)】', '═' * 80]
        
        self.table.clear()
        
        if data.ndim == 1:
            self.table.setRowCount(len(data))
            self.table.setColumnCount(2)
            self.table.setHorizontalHeaderLabels(['序号', '值'])
            
            for i, val in enumerate(data):
                self.table.setItem(i, 0, QTableWidgetItem(str(i)))
                if isinstance(val, bytes):
                    val_str = val.decode('utf-8', errors='replace')
                elif isinstance(val, (np.floating, float)):
                    val_str = f'{val:.{precision}f}'
                else:
                    val_str = str(val)
                self.table.setItem(i, 1, QTableWidgetItem(val_str))
                text_lines.append(f'{i:4d}: {val_str}')
                
        elif data.ndim == 2:
            rows, cols = data.shape
            self.table.setRowCount(rows)
            self.table.setColumnCount(cols + 1)
            headers = ['序号'] + [f'Col{j}' for j in range(cols)]
            self.table.setHorizontalHeaderLabels(headers)
            
            for i in range(rows):
                self.table.setItem(i, 0, QTableWidgetItem(str(i)))
                row_vals = []
                for j in range(cols):
                    val = data[i, j]
                    if isinstance(val, (np.floating, float)):
                        val_str = f'{val:.{precision}f}'
                    else:
                        val_str = str(val)
                    self.table.setItem(i, j + 1, QTableWidgetItem(val_str))
                    row_vals.append(val_str)
                text_lines.append(f'{i:4d}: [{", ".join(row_vals)}]')
        
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.text_preview.setText('\n'.join(text_lines))
    
    def on_preview_count_changed(self, value):
        """预览条数改变"""
        self.preview_count = value
    
    def on_precision_changed(self, value):
        """精度改变"""
        self.emg_precision = value
    
    def refresh_view(self):
        """刷新视图"""
        if self.file_path:
            self.load_file(self.file_path)
    
    def closeEvent(self, event):
        """关闭窗口时释放资源"""
        if self.h5file:
            self.h5file.close()
        event.accept()


def main():
    app = QApplication(sys.argv)
    
    # 设置应用信息
    app.setApplicationName('HDF5 Stage Viewer')
    app.setApplicationVersion('2.0')
    
    # 检查命令行参数
    file_path = None
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
    
    viewer = HDF5StageViewer(file_path)
    viewer.show()
    
    sys.exit(app.exec_())


if __name__ == '__main__':
    main()

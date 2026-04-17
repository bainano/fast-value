/**
 * FastValue - 高性能数据更新库
 * 基于输入框value属性的零DOM操作数据更新方案
 * @version 1.0.0
 * @author FastValue Team
 * @license MIT
 */

(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' 
    ? module.exports = factory() 
    : typeof define === 'function' && define.amd 
    ? define(factory) 
    : (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.FastValue = factory());
})(this, function () {
  'use strict';

  /**
   * 默认配置
   */
  const defaultConfig = {
    prefix: 'fv',
    attribute: 'data-fv-id',
    readonly: true,
    tabindex: -1,
    autoInit: true,
    batchUpdate: true,
    batchDelay: 0
  };

  /**
   * 格式化函数集合
   */
  const formatters = {
    number: (value, options = {}) => {
      const { decimals = 0, separator = ',', prefix = '', suffix = '' } = options;
      const num = parseFloat(value);
      if (isNaN(num)) return value;
      
      let formatted = decimals > 0 
        ? num.toFixed(decimals) 
        : Math.round(num).toString();
      
      if (separator) {
        const parts = formatted.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, separator);
        formatted = parts.join('.');
      }
      
      return prefix + formatted + suffix;
    },
    
    currency: (value, options = {}) => {
      const { symbol = '¥', decimals = 2 } = options;
      return formatters.number(value, { decimals, prefix: symbol });
    },
    
    percent: (value, options = {}) => {
      const { decimals = 1 } = options;
      const num = parseFloat(value);
      if (isNaN(num)) return value;
      return num.toFixed(decimals) + '%';
    },
    
    bytes: (value, options = {}) => {
      const num = parseFloat(value);
      if (isNaN(num)) return value;
      
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let unitIndex = 0;
      let size = num;
      
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      
      return size.toFixed(2) + ' ' + units[unitIndex];
    },
    
    duration: (value, options = {}) => {
      const seconds = parseInt(value);
      if (isNaN(seconds)) return value;
      
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      
      if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    },
    
    date: (value, options = {}) => {
      const { format = 'YYYY-MM-DD' } = options;
      const date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) return value;
      
      const map = {
        'YYYY': date.getFullYear(),
        'MM': String(date.getMonth() + 1).padStart(2, '0'),
        'DD': String(date.getDate()).padStart(2, '0'),
        'HH': String(date.getHours()).padStart(2, '0'),
        'mm': String(date.getMinutes()).padStart(2, '0'),
        'ss': String(date.getSeconds()).padStart(2, '0')
      };
      
      return format.replace(/YYYY|MM|DD|HH|mm|ss/g, match => map[match]);
    }
  };

  /**
   * FastValue 核心类
   */
  class FastValue {
    constructor(config = {}) {
      this.config = { ...defaultConfig, ...config };
      this.elements = new Map();
      this.groups = new Map();
      this.updateQueue = new Map();
      this.batchTimer = null;
      this.hooks = {
        beforeUpdate: [],
        afterUpdate: [],
        onError: []
      };
      
      if (this.config.autoInit) {
        this.init();
      }
    }

    /**
     * 初始化 - 扫描并注册所有带有 data-fv-id 的元素
     */
    init() {
      const selector = `[${this.config.attribute}]`;
      const elements = document.querySelectorAll(selector);
      
      elements.forEach(el => this.register(el));
      
      // 监听 DOM 变化，自动注册新元素
      this._observeDOM();
      
      return this;
    }

    /**
     * 注册单个元素
     */
    register(element) {
      if (!(element instanceof HTMLInputElement)) {
        console.warn('FastValue: Element must be an input element', element);
        return this;
      }

      const id = element.getAttribute(this.config.attribute);
      if (!id) return this;

      // 配置元素属性
      if (this.config.readonly) element.readOnly = true;
      if (this.config.tabindex !== null) element.tabIndex = this.config.tabindex;
      
      // 添加 id 和 name 属性（解决浏览器警告）
      if (!element.id) element.id = `fv-${id}`;
      if (!element.name) element.name = `fv-${id}`;
      
      // 添加 autocomplete="off" 禁用自动填充
      element.setAttribute('autocomplete', 'off');
      
      // 添加 CSS 类
      element.classList.add(`${this.config.prefix}-input`);

      // 解析配置
      const config = this._parseElementConfig(element);
      
      // 存储元素信息
      this.elements.set(id, {
        element,
        config,
        lastValue: element.value,
        updateCount: 0
      });

      // 注册到组
      if (config.group) {
        if (!this.groups.has(config.group)) {
          this.groups.set(config.group, new Set());
        }
        this.groups.get(config.group).add(id);
      }

      return this;
    }

    /**
     * 解析元素配置
     */
    _parseElementConfig(element) {
      const config = {
        formatter: element.getAttribute(`${this.config.prefix}-format`) || null,
        formatOptions: {},
        group: element.getAttribute(`${this.config.prefix}-group`) || null,
        unit: element.getAttribute(`${this.config.prefix}-unit`) || '',
        prefix: element.getAttribute(`${this.config.prefix}-prefix`) || '',
        suffix: element.getAttribute(`${this.config.prefix}-suffix`) || '',
        animate: element.hasAttribute(`${this.config.prefix}-animate`),
        precision: parseInt(element.getAttribute(`${this.config.prefix}-precision`)) || null
      };

      // 解析格式化选项
      const formatOptions = element.getAttribute(`${this.config.prefix}-format-options`);
      if (formatOptions) {
        try {
          config.formatOptions = JSON.parse(formatOptions);
        } catch (e) {
          console.warn('FastValue: Invalid format options', formatOptions);
        }
      }

      return config;
    }

    /**
     * 设置值
     */
    set(id, value) {
      const item = this.elements.get(id);
      if (!item) {
        console.warn(`FastValue: Element with id "${id}" not found`);
        return this;
      }

      // 批量更新模式
      if (this.config.batchUpdate) {
        this.updateQueue.set(id, value);
        this._scheduleBatchUpdate();
        return this;
      }

      // 直接更新
      this._updateElement(id, value);
      return this;
    }

    /**
     * 批量设置值
     */
    setBatch(updates) {
      Object.entries(updates).forEach(([id, value]) => {
        this.updateQueue.set(id, value);
      });
      this._scheduleBatchUpdate();
      return this;
    }

    /**
     * 安排批量更新
     */
    _scheduleBatchUpdate() {
      if (this.batchTimer) return;
      
      this.batchTimer = setTimeout(() => {
        this._flushBatchUpdate();
      }, this.config.batchDelay);
    }

    /**
     * 执行批量更新
     */
    _flushBatchUpdate() {
      this._emit('beforeUpdate', Object.fromEntries(this.updateQueue));
      
      const startTime = performance.now();
      
      this.updateQueue.forEach((value, id) => {
        this._updateElement(id, value);
      });
      
      const duration = performance.now() - startTime;
      
      this._emit('afterUpdate', {
        updates: Object.fromEntries(this.updateQueue),
        duration,
        count: this.updateQueue.size
      });
      
      this.updateQueue.clear();
      this.batchTimer = null;
    }

    /**
     * 更新单个元素
     */
    _updateElement(id, value) {
      const item = this.elements.get(id);
      if (!item) return;

      const { element, config } = item;
      
      // 格式化值
      let formattedValue = this._formatValue(value, config);
      
      // 添加前缀后缀
      if (config.prefix) formattedValue = config.prefix + formattedValue;
      if (config.suffix) formattedValue = formattedValue + config.suffix;
      
      // 执行更新 - 核心性能优化点
      const oldValue = element.value;
      element.value = formattedValue;
      
      // 更新统计
      item.lastValue = formattedValue;
      item.updateCount++;
      
      // 触发动画
      if (config.animate) {
        this._animateUpdate(element, oldValue, formattedValue);
      }
      
      // 触发自定义事件
      element.dispatchEvent(new CustomEvent('fv:update', {
        detail: { id, oldValue, newValue: formattedValue, rawValue: value }
      }));
    }

    /**
     * 格式化值
     */
    _formatValue(value, config) {
      if (config.formatter && formatters[config.formatter]) {
        return formatters[config.formatter](value, config.formatOptions);
      }
      
      if (config.precision !== null && !isNaN(parseFloat(value))) {
        return parseFloat(value).toFixed(config.precision);
      }
      
      return String(value);
    }

    /**
     * 动画更新效果
     */
    _animateUpdate(element, oldValue, newValue) {
      element.classList.add(`${this.config.prefix}-updating`);
      
      requestAnimationFrame(() => {
        element.classList.remove(`${this.config.prefix}-updating`);
        element.classList.add(`${this.config.prefix}-updated`);
        
        setTimeout(() => {
          element.classList.remove(`${this.config.prefix}-updated`);
        }, 300);
      });
    }

    /**
     * 获取值
     */
    get(id) {
      const item = this.elements.get(id);
      return item ? item.element.value : undefined;
    }

    /**
     * 获取原始值（去除前缀后缀）
     */
    getRaw(id) {
      const item = this.elements.get(id);
      if (!item) return undefined;
      
      let value = item.element.value;
      const { config } = item;
      
      if (config.prefix) value = value.replace(new RegExp(`^${config.prefix}`), '');
      if (config.suffix) value = value.replace(new RegExp(`${config.suffix}$`), '');
      
      return value;
    }

    /**
     * 按组更新
     */
    setGroup(groupName, values) {
      const group = this.groups.get(groupName);
      if (!group) {
        console.warn(`FastValue: Group "${groupName}" not found`);
        return this;
      }

      group.forEach(id => {
        if (values.hasOwnProperty(id)) {
          this.set(id, values[id]);
        }
      });

      return this;
    }

    /**
     * 获取组内所有值
     */
    getGroup(groupName) {
      const group = this.groups.get(groupName);
      if (!group) return {};

      const result = {};
      group.forEach(id => {
        result[id] = this.get(id);
      });

      return result;
    }

    /**
     * 监听 DOM 变化
     */
    _observeDOM() {
      if (!window.MutationObserver) return;

      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查自身
              if (node.hasAttribute && node.hasAttribute(this.config.attribute)) {
                this.register(node);
              }
              // 检查子元素
              const children = node.querySelectorAll 
                ? node.querySelectorAll(`[${this.config.attribute}]`)
                : [];
              children.forEach(el => this.register(el));
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    /**
     * 注册钩子
     */
    on(event, callback) {
      if (this.hooks[event]) {
        this.hooks[event].push(callback);
      }
      return this;
    }

    /**
     * 触发钩子
     */
    _emit(event, data) {
      if (this.hooks[event]) {
        this.hooks[event].forEach(callback => {
          try {
            callback(data);
          } catch (e) {
            console.error('FastValue: Hook error', e);
          }
        });
      }
    }

    /**
     * 注册自定义格式化器
     */
    static registerFormatter(name, fn) {
      formatters[name] = fn;
    }

    /**
     * 获取统计信息
     */
    getStats(id) {
      const item = this.elements.get(id);
      if (!item) return null;

      return {
        updateCount: item.updateCount,
        lastValue: item.lastValue,
        element: item.element
      };
    }

    /**
     * 获取所有注册的元素ID
     */
    getIds() {
      return Array.from(this.elements.keys());
    }

    /**
     * 获取所有组名
     */
    getGroups() {
      return Array.from(this.groups.keys());
    }

    /**
     * 销毁实例
     */
    destroy() {
      this.elements.clear();
      this.groups.clear();
      this.updateQueue.clear();
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
      }
    }
  }

  // 创建默认实例
  let defaultInstance = null;

  /**
   * 快速访问方法
   */
  FastValue.init = (config) => {
    defaultInstance = new FastValue(config);
    return defaultInstance;
  };

  FastValue.set = (id, value) => {
    if (!defaultInstance) FastValue.init();
    return defaultInstance.set(id, value);
  };

  FastValue.get = (id) => {
    if (!defaultInstance) return undefined;
    return defaultInstance.get(id);
  };

  FastValue.setBatch = (updates) => {
    if (!defaultInstance) FastValue.init();
    return defaultInstance.setBatch(updates);
  };

  return FastValue;
});

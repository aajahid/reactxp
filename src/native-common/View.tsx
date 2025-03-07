/**
* View.tsx
*
* Copyright (c) Microsoft Corporation. All rights reserved.
* Licensed under the MIT license.
*
* RN-specific implementation of the cross-platform View abstraction.
*/

import * as PropTypes from 'prop-types';
import * as React from 'react';
import * as RN from 'react-native';

import assert from '../common/assert';
import { FocusArbitratorProvider } from '../common/utils/AutoFocusHelper';
import * as RX from '../common/Interfaces';
import Timers from '../common/utils/Timers';

import { MacComponentAccessibilityProps } from './Accessibility';
import AccessibilityUtil from './AccessibilityUtil';
import Animated from './Animated';
import App from './App';
import EventHelpers from './utils/EventHelpers';
import { clone, extend } from './utils/lodashMini';
import Platform from './Platform';
import Styles from './Styles';
import UserInterface from './UserInterface';
import ViewBase from './ViewBase';

const _isNativeMacOs = Platform.getType() === 'macos';

const LayoutAnimation = RN.LayoutAnimation;

// Note: a lot of code is duplicated with Button due to View currently supporting a lot of features Button does.
const _defaultActiveOpacity = 0.2;
const _inactiveOpacityAnimationDuration = 250;
const _activeOpacityAnimationDuration = 0;
const _hideUnderlayTimeout = 100;
const _underlayInactive = 'transparent';

const safeInsetsStyle = Styles.createViewStyle({ flex: 1, alignSelf: 'stretch' });

function noop() { /* noop */ }

function applyMixin(thisObj: any, mixin: {[propertyName: string]: any}, propertiesToSkip: string[]) {
    Object.getOwnPropertyNames(mixin).forEach(name => {
        if (name !== 'constructor' && propertiesToSkip.indexOf(name) === -1 && typeof mixin[name].bind === 'function') {
            assert(
                !(name in thisObj),
                `An object cannot have a method with the same name as one of its mixins: "${name}"`,
            );
            thisObj[name] = mixin[name].bind(thisObj);
        }
    });
}

function removeMixin(thisObj: any, mixin: {[propertyName: string]: any}, propertiesToSkip: string[]) {
    Object.getOwnPropertyNames(mixin).forEach(name => {
        if (name !== 'constructor' && propertiesToSkip.indexOf(name) === -1) {
            assert(
                (name in thisObj),
                `An object is missing a mixin method: "${name}"`,
            );
            delete thisObj[name];
        }
    });
}

type ChildKey = string | number;
function extractChildrenKeys(children: React.ReactNode): ChildKey[] {
    const keys: ChildKey[] = [];
    React.Children.forEach(children, function(child, index) {
        if (child) {
            const childReactElement = child as React.ReactElement<any>;
            assert(
                childReactElement.key !== undefined && childReactElement.key !== null,
                'Children passed to a `View` with child animations enabled must have a `key`',
            );
            if (childReactElement.key !== null) {
                keys.push(childReactElement.key);
            }
        }
    });
    return keys;
}

function findInvalidRefs(children: React.ReactNode) {
    const invalidRefs: string[] = [];
    React.Children.forEach(children, function(child) {
        if (child) {
            const childElement = child as any;
            if (typeof childElement.ref !== 'function' && childElement.ref !== undefined && childElement.ref !== null) {
                invalidRefs.push(childElement.ref as string);
            }
        }
    });
    return invalidRefs;
}

// Returns true if an item was added or moved. We use this information to determine
// whether or not we'll need to play any list edit animations.
function _childrenEdited(prevChildrenKeys: ChildKey[], nextChildrenKeys: ChildKey[]): boolean {
    const prevLength = prevChildrenKeys ? prevChildrenKeys.length : 0;
    const nextLength = nextChildrenKeys ? nextChildrenKeys.length : 0;

    // Were new items added?
    if (nextLength > prevLength) {
        return true;
    }

    // See if changes were limited to removals. Any additions or moves should return true.
    let prevIndex = 0;
    for (let nextIndex = 0; nextIndex < nextLength; nextIndex++) {
        if (prevChildrenKeys[prevIndex] === nextChildrenKeys[nextIndex]) {
            prevIndex++;
        } else {
            // If there are more "next" items left than there are "prev" items left,
            // then we know that something has been added or moved.
            if (nextLength - nextIndex > prevLength - prevIndex) {
                return true;
            }
        }
    }

    return false;
}

export interface ViewContext {
    focusArbitrator?: FocusArbitratorProvider;
}

export class View extends ViewBase<RX.Types.ViewProps, RX.Types.Stateless, RN.View, RX.View> {
    static contextTypes: React.ValidationMap<any> = {
        focusArbitrator: PropTypes.object,
    };

    context!: ViewContext;

    static childContextTypes: React.ValidationMap<any> = {
        focusArbitrator: PropTypes.object,
    };

    protected _internalProps: any = {};

    // Assigned when mixin is applied
    touchableGetInitialState!: () => RN.Touchable.State;
    touchableHandleStartShouldSetResponder!: () => boolean;
    touchableHandleResponderTerminationRequest!: () => boolean;
    touchableHandleResponderGrant!: (e: React.SyntheticEvent<any>) => void;
    touchableHandleResponderMove!: (e: React.SyntheticEvent<any>) => void;
    touchableHandleResponderRelease!: (e: React.SyntheticEvent<any>) => void;
    touchableHandleResponderTerminate!: (e: React.SyntheticEvent<any>) => void;

    private _mixinIsApplied = false;
    private _childrenKeys: ChildKey[] | undefined;

    private _mixin_componentDidMount?: () => void;
    private _mixin_componentWillUnmount?: () => void;

    protected _isMounted = false;
    private _hideTimeout: number | undefined;
    private _defaultOpacityValue: number | undefined;
    private _opacityAnimatedValue: RN.Animated.Value | undefined;
    private _opacityAnimatedStyle: RX.Types.AnimatedViewStyleRuleSet | undefined;

    private _focusArbitratorProvider: FocusArbitratorProvider | undefined;

    constructor(props: RX.Types.ViewProps, context?: ViewContext) {
        super(props, context);
        this._updateMixin(props, true);
        this._buildInternalProps(props);

        if (props.arbitrateFocus) {
            this._updateFocusArbitratorProvider(props);
        }
    }

    UNSAFE_componentWillReceiveProps(nextProps: RX.Types.ViewProps) {
        this._updateMixin(nextProps, false);
        this._buildInternalProps(nextProps);

        if (('arbitrateFocus' in nextProps) && (this.props.arbitrateFocus !== nextProps.arbitrateFocus)) {
            this._updateFocusArbitratorProvider(nextProps);
        }
    }

    UNSAFE_componentWillUpdate(nextProps: RX.Types.ViewProps, nextState: {}) {
        //
        // Exit fast if not an "animated children" case
        if (!(nextProps.animateChildEnter || nextProps.animateChildMove || nextProps.animateChildLeave)) {
            return;
        }

        // Each time the component receives new children, animates insertions, removals,
        // and moves that occurred since the previous render. Uses React Native's
        // LayoutAnimation API to achieve this.
        //
        // Caveats:
        //   - The animations are not scoped. All layout changes in the app that occur during the
        //     next bridge transaction will be animated. This is due to a limitation in React Native's
        //     LayoutAnimation API.
        //   - Removals are not animated. The removed item disappears instantly. Items whose positions
        //     were affected by the removal are animated into their new positions. This is due to a
        //     limitation in React Native's LayoutAnimation API.
        //

        // The web implementation doesn't support string refs. For consistency, do the same assert
        // in the native implementation.
        assert(
            findInvalidRefs(nextProps.children).length === 0,
            'Invalid ref(s): ' + JSON.stringify(findInvalidRefs(nextProps.children)) +
            ' Only callback refs are supported when using child animations on a `View`',
        );

        const prevChildrenKeys = this._childrenKeys || [];
        const nextChildrenKeys = extractChildrenKeys(nextProps.children);
        this._childrenKeys = nextChildrenKeys;
        if (_childrenEdited(prevChildrenKeys, nextChildrenKeys)) {
            const updateConfig: RN.LayoutAnimationAnim = {
                delay: 0,
                duration: 300,
                type: LayoutAnimation.Types.easeOut,
            };
            const createConfig: RN.LayoutAnimationAnim = {
                delay: 75,
                duration: 150,
                type: LayoutAnimation.Types.linear,
                property: LayoutAnimation.Properties.opacity,
            };
            const configDictionary: RN.LayoutAnimationConfig = {
                duration: 300,
            };

            if (nextProps.animateChildMove) {
                configDictionary.update = updateConfig;
            }

            if (nextProps.animateChildEnter) {
                configDictionary.create = createConfig;
            }

            LayoutAnimation.configureNext(configDictionary);
        }
    }

    componentDidMount() {
        this._isMounted = true;
        if (this._mixin_componentDidMount) {
            this._mixin_componentDidMount();
        }

        if (this.props.autoFocus) {
            this.requestFocus();
        }
    }

    componentWillUnmount() {
        this._isMounted = false;
        if (this._mixin_componentWillUnmount) {
            this._mixin_componentWillUnmount();
        }
    }

    private _updateMixin(props: RX.Types.ViewProps, initial: boolean) {
        const isButton = this._isButton(props);
        if (isButton && !this._mixinIsApplied) {
            // Create local handlers
            this.touchableHandlePress = this.touchableHandlePress.bind(this);
            this.touchableHandleLongPress = this.touchableHandleLongPress.bind(this);
            this.touchableGetPressRectOffset = this.touchableGetPressRectOffset.bind(this);
            this.touchableHandleActivePressIn = this.touchableHandleActivePressIn.bind(this);
            this.touchableHandleActivePressOut = this.touchableHandleActivePressOut.bind(this);
            this.touchableGetHighlightDelayMS = this.touchableGetHighlightDelayMS.bind(this);

            applyMixin(this, RN.Touchable.Mixin, [
                // Properties that View and RN.Touchable.Mixin have in common. View needs
                // to dispatch these methods to RN.Touchable.Mixin manually.
                'componentDidMount',
                'componentWillUnmount',
            ]);

            this._mixin_componentDidMount = RN.Touchable.Mixin.componentDidMount || noop;
            this._mixin_componentWillUnmount = RN.Touchable.Mixin.componentWillUnmount || noop;

            if (initial) {
                this.state = this.touchableGetInitialState();
            } else {
                this.setState(this.touchableGetInitialState());
            }

            this._mixinIsApplied = true;
        } else if (!isButton && this._mixinIsApplied) {
            removeMixin(this, RN.Touchable.Mixin, [
                'componentDidMount',
                'componentWillUnmount',
            ]);

            delete this._mixin_componentDidMount;
            delete this._mixin_componentWillUnmount;

            delete this.touchableHandlePress;
            delete this.touchableHandleLongPress;
            delete this.touchableGetPressRectOffset;
            delete this.touchableHandleActivePressIn;
            delete this.touchableHandleActivePressOut;
            delete this.touchableGetHighlightDelayMS;

            this._mixinIsApplied = false;
        }
    }

    getChildContext() {
        const childContext: ViewContext = {};

        if (this._focusArbitratorProvider) {
            childContext.focusArbitrator = this._focusArbitratorProvider;
        }

        return childContext;
    }

    /**
     * Attention:
     * be careful with setting any non layout properties unconditionally in this method to any value
     * as on android that would lead to extra layers of Views.
     */
    protected _buildInternalProps(props: RX.Types.ViewProps) {
        this._internalProps = clone(props) as any;
        this._internalProps.ref = this._setNativeComponent;

        if (props.testId) {
            // Convert from testId to testID.
            this._internalProps.testID = this._internalProps.testId;
            delete this._internalProps.testId;
        }

        // Translate accessibilityProps from RX to RN, there are type diferrences for example:
        // accessibilityLiveRegion prop is number (RX.Types.AccessibilityLiveRegion) in RX, but
        // string is expected by RN.View
        const accessibilityProps = {
            importantForAccessibility: AccessibilityUtil.importantForAccessibilityToString(props.importantForAccessibility),
            accessibilityLabel: props.accessibilityLabel || props.title,
            accessibilityTraits: AccessibilityUtil.accessibilityTraitToString(props.accessibilityTraits),
            accessibilityComponentType: AccessibilityUtil.accessibilityComponentTypeToString(props.accessibilityTraits),
            accessibilityLiveRegion: AccessibilityUtil.accessibilityLiveRegionToString(props.accessibilityLiveRegion),
        };
        if (_isNativeMacOs && App.supportsExperimentalKeyboardNavigation && (props.onPress ||
                (props.tabIndex !== undefined && props.tabIndex >= 0))) {
            const macAccessibilityProps: MacComponentAccessibilityProps = accessibilityProps as any;
            if (props.tabIndex !== -1) {
                macAccessibilityProps.acceptsKeyboardFocus = true;
                macAccessibilityProps.enableFocusRing = true;
            }
            if (props.onPress) {
                macAccessibilityProps.onClick = props.onPress;
            }
        }
        this._internalProps = extend(this._internalProps, accessibilityProps);

        if (props.onLayout) {
            this._internalProps.onLayout = this._onLayout;
        }

        if (props.blockPointerEvents) {
            this._internalProps.pointerEvents = 'none';
        } else {
            if (props.ignorePointerEvents) {
                this._internalProps.pointerEvents = 'box-none';
            }
        }

        if (props.onKeyPress) {
            this._internalProps.onKeyPress = this._onKeyPress;
        }

        const baseStyle = this._getStyles(props);
        this._internalProps.style = baseStyle;
        if (this._mixinIsApplied) {
            const responderProps = {
                onStartShouldSetResponder: this.props.onStartShouldSetResponder || this.touchableHandleStartShouldSetResponder,
                onResponderTerminationRequest: this.props.onResponderTerminationRequest || this.touchableHandleResponderTerminationRequest,
                onResponderGrant: this.props.onResponderGrant || this.touchableHandleResponderGrant,
                onResponderMove: this.props.onResponderMove || this.touchableHandleResponderMove,
                onResponderRelease: this.props.onResponderRelease || this.touchableHandleResponderRelease,
                onResponderTerminate: this.props.onResponderTerminate || this.touchableHandleResponderTerminate,
            };
            this._internalProps = extend(this._internalProps, responderProps);

            if (!this.props.disableTouchOpacityAnimation) {
                const opacityValueFromProps = this._getDefaultOpacityValue(props);
                if (this._defaultOpacityValue !== opacityValueFromProps) {
                    this._defaultOpacityValue = opacityValueFromProps;
                    this._opacityAnimatedValue = new Animated.Value(this._defaultOpacityValue);
                    this._opacityAnimatedStyle = Styles.createAnimatedViewStyle({
                        opacity: this._opacityAnimatedValue,
                    });
                }
                this._internalProps.style = Styles.combine([baseStyle as any, this._opacityAnimatedStyle]);
            }

            this._internalProps.tooltip = this.props.title;
        }

        if (this.props.useSafeInsets) {
            this._internalProps.style = Styles.combine([this._internalProps.style, safeInsetsStyle]);
        }
    }

    private _onKeyPress = (e: RN.NativeSyntheticEvent<RN.TextInputKeyPressEventData>) => {
        if (this.props.onKeyPress) {
            this.props.onKeyPress(EventHelpers.toKeyboardEvent(e));
        }
    };

    private _isTouchFeedbackApplicable() {
        return this._isMounted && this._mixinIsApplied && !!this._nativeComponent;
    }

    private _opacityActive(duration: number) {
        this._setOpacityTo(this.props.activeOpacity || _defaultActiveOpacity, duration);
    }

    private _opacityInactive(duration: number) {
        this._setOpacityTo(this._defaultOpacityValue!, duration);
    }

    private _getDefaultOpacityValue(props: RX.Types.ViewProps): number {
        let flattenedStyles: { [key: string]: any } | undefined;
        if (props && props.style) {
            flattenedStyles = RN.StyleSheet.flatten(props.style as RN.StyleProp<RN.ViewStyle>);
        }

        return flattenedStyles && flattenedStyles.opacity || 1;
    }

    private _setOpacityTo(value: number, duration: number) {
        Animated.timing(
            this._opacityAnimatedValue!,
            {
                toValue: value,
                duration: duration,
                easing: Animated.Easing.InOut(),
                useNativeDriver: true
            },
        ).start();
    }

    private _showUnderlay() {
        if (!this._nativeComponent) {
            return;
        }

        this._nativeComponent.setNativeProps({
            style: {
                backgroundColor: this.props.underlayColor,
            },
        });
    }

    private _hideUnderlay = () => {
        if (!this._isMounted || !this._nativeComponent) {
            return;
        }

        this._nativeComponent.setNativeProps({
            style: [{
                backgroundColor: _underlayInactive,
            }, this.props.style],
        });
    };

    protected _isButton(viewProps: RX.Types.ViewProps): boolean {
        return !!(viewProps.onPress || viewProps.onLongPress);
    }

    private _updateFocusArbitratorProvider(props: RX.Types.ViewProps) {
        if (props.arbitrateFocus) {
            if (this._focusArbitratorProvider) {
                this._focusArbitratorProvider.setCallback(props.arbitrateFocus);
            } else {
                this._focusArbitratorProvider = new FocusArbitratorProvider(this, props.arbitrateFocus);
            }
        } else if (this._focusArbitratorProvider) {
            delete this._focusArbitratorProvider;
        }
    }

    render() {
        let ViewToRender: typeof RN.Animated.View | typeof RN.SafeAreaView = RN.View;

        if (this._isButton(this.props)) {
            ViewToRender = RN.Animated.View;
        } else if (this.props.useSafeInsets) {
            ViewToRender = RN.SafeAreaView;
        }

        return (
            <ViewToRender { ...this._internalProps }>
                { this.props.children }
            </ViewToRender>
        );
    }

    touchableHandlePress(e: RX.Types.SyntheticEvent): void {
        UserInterface.evaluateTouchLatency(e);
        if (EventHelpers.isRightMouseButton(e)) {
            if (this.props.onContextMenu) {
                this.props.onContextMenu(EventHelpers.toMouseEvent(e));
            }
        } else {
            if (this.props.onPress) {
                this.props.onPress(EventHelpers.toMouseEvent(e));
            }
        }
    }

    touchableHandleLongPress(e: RX.Types.SyntheticEvent): void {
        if (!EventHelpers.isRightMouseButton(e)) {
            if (this.props.onLongPress) {
                this.props.onLongPress(EventHelpers.toMouseEvent(e));
            }
        }
    }

    touchableHandleActivePressIn(e: RX.Types.SyntheticEvent): void {
        if (this._isTouchFeedbackApplicable()) {
            if (this.props.underlayColor) {
                if (this._hideTimeout) {
                    Timers.clearTimeout(this._hideTimeout);
                    this._hideTimeout = undefined;
                }
                this._showUnderlay();
            }

            // We do not want to animate opacity if underlayColour is provided. Unless an explicit activeOpacity is provided
            if (!this.props.disableTouchOpacityAnimation && (this.props.activeOpacity || !this.props.underlayColor)) {
                this._opacityActive(_activeOpacityAnimationDuration);
            }
        }
    }

    touchableHandleActivePressOut(e: RX.Types.SyntheticEvent): void {
        if (this._isTouchFeedbackApplicable()) {
            if (this.props.underlayColor) {
                if (this._hideTimeout) {
                    Timers.clearTimeout(this._hideTimeout);
                }
                this._hideTimeout = Timers.setTimeout(this._hideUnderlay, _hideUnderlayTimeout);
            }

            if (!this.props.disableTouchOpacityAnimation && (this.props.activeOpacity || !this.props.underlayColor)) {
                this._opacityInactive(_inactiveOpacityAnimationDuration);
            }
        }
    }

    touchableGetHighlightDelayMS(): number {
        return 20;
    }

    touchableGetPressRectOffset() {
        return {top: 20, left: 20, right: 20, bottom: 100};
    }

    setFocusRestricted(restricted: boolean) {
        // Nothing to do.
    }

    setFocusLimited(limited: boolean) {
        // Nothing to do.
    }

    blur() {
        if (ViewBase._supportsNativeFocusBlur && this._nativeComponent && this._nativeComponent.blur) {
            this._nativeComponent.blur();
        }
    }

    requestFocus() {
        FocusArbitratorProvider.requestFocus(
            this,
            () => this.focus(),
            () => this._isMounted,
        );
    }

    focus() {
        if (this._isMounted) {
            AccessibilityUtil.setAccessibilityFocus(this);
        }
        if (ViewBase._supportsNativeFocusBlur && this._nativeComponent) {
            if (this._nativeComponent.focus) {
                this._nativeComponent.focus();
            } else if ((this._nativeComponent as any)._component) {
                // Components can be wrapped by RN.Animated implementation, peek at the inner workings here
                const innerComponent = (this._nativeComponent as any)._component;
                if (innerComponent && innerComponent.focus) {
                    innerComponent.focus();
                }
            }
        }
    }
}

export default View;

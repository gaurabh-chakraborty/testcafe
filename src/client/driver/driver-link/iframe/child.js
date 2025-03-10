import {
    Promise,
    eventSandbox,
    nativeMethods,
} from '../../deps/hammerhead';

import {
    domUtils,
    delay,
    waitFor,
    positionUtils,
} from '../../deps/testcafe-core';

import {
    CurrentIframeIsNotLoadedError,
    CurrentIframeNotFoundError,
    CurrentIframeIsInvisibleError,
} from '../../../../shared/errors';

import sendMessageToDriver from '../send-message-to-driver';
import { ExecuteCommandMessage, TYPE as MESSAGE_TYPE } from '../messages';
import DriverStatus from '../../status';
import {
    CHECK_IFRAME_EXISTENCE_INTERVAL,
    CHECK_IFRAME_VISIBLE_INTERVAL,
    WAIT_IFRAME_RESPONSE_DELAY,
} from '../timeouts';

import sendConfirmationMessage from '../send-confirmation-message';
import { getBordersWidthFloat, getElementPaddingFloat } from '../../../core/utils/style';


export default class ChildIframeDriverLink {
    constructor (driverWindow, driverId, dispatchProxylessEventUrl) {
        this.driverWindow              = driverWindow;
        this.driverIframe              = domUtils.findIframeByWindow(driverWindow);
        this.driverId                  = driverId;
        this.iframeAvailabilityTimeout = 0;
        this.dispatchProxylessEventUrl = dispatchProxylessEventUrl;
    }

    set availabilityTimeout (val) {
        this.iframeAvailabilityTimeout = val;
    }

    _ensureIframe () {
        if (!domUtils.isElementInDocument(this.driverIframe))
            return Promise.reject(new CurrentIframeNotFoundError());

        return waitFor(() => positionUtils.isIframeVisible(this.driverIframe) ? this.driverIframe : null,
            CHECK_IFRAME_VISIBLE_INTERVAL, this.iframeAvailabilityTimeout)
            .catch(() => {
                throw new CurrentIframeIsInvisibleError();
            });
    }

    _waitForIframeRemovedOrHidden () {
        // NOTE: If an iframe was removed or became hidden while a
        // command was being executed, we consider this command finished.
        return new Promise(resolve => {
            this.checkIframeInterval = nativeMethods.setInterval.call(window,
                () => {
                    this._ensureIframe()
                        .catch(() => {
                            // NOTE: wait for possible delayed iframe message
                            return delay(WAIT_IFRAME_RESPONSE_DELAY)
                                .then(() => resolve(new DriverStatus({ isCommandResult: true })));
                        });
                }, CHECK_IFRAME_EXISTENCE_INTERVAL);
        });
    }

    _waitForCommandResult () {
        let onMessage = null;

        const waitForResultMessage = () => new Promise(resolve => {
            onMessage = e => {
                if (e.message.type === MESSAGE_TYPE.commandExecuted)
                    resolve(e.message.driverStatus);
            };

            eventSandbox.message.on(eventSandbox.message.SERVICE_MSG_RECEIVED_EVENT, onMessage);
        });


        return Promise.race([this._waitForIframeRemovedOrHidden(), waitForResultMessage()])
            .then(status => {
                eventSandbox.message.off(eventSandbox.message.SERVICE_MSG_RECEIVED_EVENT, onMessage);
                nativeMethods.clearInterval.call(window, this.checkIframeInterval);

                return status;
            });
    }

    _getLeftTopPoint (proxyless) {
        if (!proxyless)
            return null;

        const rect     = this.driverIframe.getBoundingClientRect();
        const borders  = getBordersWidthFloat(this.driverIframe);
        const paddings = getElementPaddingFloat(this.driverIframe);

        return {
            x: rect.left + borders.left + paddings.left,
            y: rect.top + borders.top + paddings.top,
        };
    }

    sendConfirmationMessage (requestMsgId) {
        sendConfirmationMessage({
            requestMsgId,
            result: { id: this.driverId, dispatchProxylessEventUrl: this.dispatchProxylessEventUrl },
            window: this.driverWindow,
        });
    }

    executeCommand (command, testSpeed, proxyless, leftTopPoint) {
        // NOTE:  We should check if the iframe is visible and exists before executing the next
        // command, because the iframe might be hidden or removed since the previous command.
        return this
            ._ensureIframe()
            .then(() => {
                const currentLeftTopPoint = this._getLeftTopPoint(proxyless);

                if (leftTopPoint) {
                    currentLeftTopPoint.x += leftTopPoint.x;
                    currentLeftTopPoint.y += leftTopPoint.y;
                }

                const msg = new ExecuteCommandMessage(command, testSpeed, currentLeftTopPoint);

                return Promise.all([
                    sendMessageToDriver(msg, this.driverWindow, this.iframeAvailabilityTimeout, CurrentIframeIsNotLoadedError),
                    this._waitForCommandResult(),
                ]);
            })
            .then(result => result[1]);
    }
}

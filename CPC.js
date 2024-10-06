/**
 * Communication Panel Control (CPC) - For Sinch Communication Panel
 * @author Sinch Contact Pro Engineering team.
 * @license MIT
 * @link https://github.com/sinch-contact-pro/CPC
 */

/**
 * @namespace CPC
 * @description
 * <b>Remember:</b> CPC is a client-side API. Actions are carried out in context of current logged on user. Returned values depend on user account's rights.<br/><br/>
 * <b>Terminology:</b> CPC API and this document use the term "<b>interaction</b>" when referring to inbound or outbound conversations with customers. The term "<b>conversation</b>" is used in other Sinch Contact Pro applications.<br/><br/>
 * <b>Tip:</b> Remember to <code>await</code> when using <code>async</code> methods.<br/><br/>
 * Have a great time integrating Communication Panel into your application!  &#128512;
 *
*/

/**
 * @namespace CommunicationPanelControl
 * @description If <b>window.CPC</b> is already reserved and thus cannot be added by CPC.js, use alternative namespace <b>window.CommunicationPanelControl</b> to access the API.
 */

(function () {
    /**
     * @ignore
     */
    const CPC = new function () {
        const _sProdName = 'CPC';
        let _sCpOrigin;
        let _bDebug = false;
        let _oCpFrame = null;
        const _sInitRequest = 'initRequest';
        let _iActionRequestCount = 0;
        const _iActionMaxWaitCount = 15;
        const _oPendingActions = {};
        const _oInteractions = new Map();
        let _sTenantBaseUrl;
        let _oParentElement;
        let _bChannelStatusUpdatesEnabled = false;
        const _sDevTenant = new URL(window.location.href).searchParams.get('devTenant');
        let _sAuthUrl;
        if (_sDevTenant || _sTenantBaseUrl) {
            _sAuthUrl = _sDevTenant || _sTenantBaseUrl + 'ecfs/authentication/'; // Note! Remember to include last trailing slash - Otherwise pre-flight OPTIONS is not routed to CorsFilter
        }

        // Helper for writing nicer console log:
        const Log = (severity, section, message) => {
            const CheckTime = (i, unit) => {
                let ret = '';
                if (unit === 'ms' && i < 100) ret = '0' + i;
                else if (i < 10) ret = '0' + i;
                else ret = i.toString();
                return ret;
            };
            if ((_bDebug || severity !== 'DBG') && window.console) {
                const today = new Date();
                const h = today.getHours();
                const m = CheckTime(today.getMinutes(), 'm');
                const s = CheckTime(today.getSeconds(), 's');
                const ms = CheckTime(today.getMilliseconds(), 'ms');
                const line = '[' + h + ':' + m + ':' + s + '.' + ms + '] ' + severity + '> ' + _sProdName + '.' + section + '() - ' + message;
                switch (severity) {
                case 'ERR': console.error(line); break;
                case 'WRN': console.warn(line); break;
                default: console.log(line);
                }
            }
        };

        // Input sanitation helpers:
        const isString = val => typeof val === 'string';
        const isBoolean = val => typeof val === 'boolean';
        const isArray = val => val instanceof Array;
        const isFunction = val => val && {}.toString.call(val) === '[object Function]';
        const isDataObject = val => typeof val === 'object' && typeof val !== 'string' && val !== null;
        const isUid = val => isString(val) && val.length === 32;

        // Starts window message listener:
        const startMessageListener = () => {
            Log('DBG', 'startMessageListener', 'Starting listener');
            window.addEventListener('message', (message) => {
                if (message.origin !== _sCpOrigin) return;
                if (!isDataObject(message.data)) return;
                if (message.data.payload.type === 'MESSAGE') return; // Ignore SAP C4C / legacy type messages
                Log('DBG', 'startMessageListener.message', JSON.stringify(message.data));
                if (!this.isInitialized) {
                    this.isInitialized = true;
                    Log('DBG', 'startMessageListener.message', 'First message receieved from CP, setting CPC.isInitialised to true');
                }
                if (message.data.type === 'init' && message.data.payload.value.length === 0) {
                    const getUserData = async () => {
                        const userDetailsResponse = await this.getDetails('user');
                        this.currentUser = userDetailsResponse.payload.value;
                        this.hostAppEventHandler({
                            // Fabricate an event to notify customer event handler of when CPC has successfully initialized window messaging with Communication Panel.
                            id: 'cpc-init',
                            type: 'status',
                            payload: {
                                attribute: 'init',
                                value: this.currentUser
                            }
                        });
                    };
                    getUserData();
                } else if (message.data.type === 'response' && _oPendingActions[message.data.id]) {
                    Log('DBG', 'message', 'Got response for action [' + message.data.id + ']: ' + JSON.stringify(message.data));
                    _oPendingActions[message.data.id].response = message.data;
                } else if (message.data.type === 'state' && message.data.payload.attribute === 'activeInteraction') {
                    if ((message.data.payload.value === null && this.activeInteractionId !== null) || (message.data.payload.value !== null && message.data.payload.value.id !== this.activeInteractionId)) {
                        this.activeInteractionId = message.data.payload.value?.id || null;
                        if (this.activeInteractionId) {
                            Log('DBG', 'message', 'Active & in-view interaction changed to [' + this.activeInteractionId + ']');
                        } else {
                            Log('DBG', 'message', 'Active & in-view interaction: None');
                        }
                        const activeInteractionEvent = message.data;
                        activeInteractionEvent.payload.value = this.activeInteractionId;
                        this.hostAppEventHandler(activeInteractionEvent);
                    }
                } else if (message.data.type === 'state' && message.data.payload.attribute === 'status') {
                    (async () => {
                        let interaction = message.data.payload.interaction;
                        const cachedInteraction = _oInteractions.get(interaction.id);
                        if (cachedInteraction) {
                            interaction = { ...cachedInteraction, ...interaction };
                            Log('DBG', 'message', 'Interaction [' + interaction.id + '] found in cache');
                        } else {
                            interaction = {
                                ...interaction,
                                ...{
                                    date_incoming: null,
                                    date_outgoing: null,
                                    date_accepted: null,
                                    date_rejected: null,
                                    date_ended: null,
                                    date_handled: null
                                }
                            };
                            _oInteractions.set(interaction.id, interaction);
                            Log('DBG', 'message', 'Interaction [' + interaction.id + '] added to cache');
                        }
                        const now = new Date().toISOString();
                        switch (message.data.payload.value) {
                        case 'incoming': interaction.date_incoming = now; break;
                        case 'outgoing': interaction.date_outgoing = now; break;
                        case 'accepted': interaction.date_accepted = now; break;
                        case 'rejected': interaction.date_rejected = now; break;
                        case 'ended': interaction.date_ended = now; break;
                        case 'handled': interaction.date_handled = now; break;
                        }
                        if (message.data.payload.value === 'handled') {
                            _oInteractions.delete(interaction.id);
                            Log('DBG', 'message', 'Handled interaction [' + interaction.id + '] cleared from cache');
                        } else {
                            _oInteractions.set(interaction.id, interaction);
                            Log('DBG', 'message', 'Interaction [' + interaction.id + '] updated in cache');
                        }
                        Log('DBG', 'message', 'Communication Panel ongoing conversations: [' + _oInteractions.size + ']');
                        const interactionEvent = message.data;
                        interactionEvent.payload.interaction = interaction;
                        this.hostAppEventHandler(interactionEvent);
                        if (_oInteractions.size === 0) {
                            this.activeInteractionId = undefined;
                        }
                    })();
                } else if (message.data.type === 'state' && message.data.payload.attribute === 'channel_status' && !_bChannelStatusUpdatesEnabled) {
                    Log('DBG', 'message', 'Ignoring channel_status update');
                } else this.hostAppEventHandler(message.data);
            });
            Log('TRC', 'startMessageListener', 'Listening for window messages from ' + _sCpOrigin);
        };

        // Sends message to Communication Panel:
        const sendToCommunicationPanel = (payload) => {
            Log('DBG', 'sendToCommunicationPanel', JSON.stringify(payload));
            if (_oCpFrame === null) {
                Log('WRN', 'sendToCommunicationPanel', 'Cannot send before iframe is loaded & ready');
                return;
            }
            _oCpFrame.contentWindow.postMessage(payload, _sCpOrigin);
        };

        /**
         * @alias activeInteractionId
         * @type {string|undefined|null}
         * @description ID of current active <a href="global.html#interaction">interaction</a> being viewed in Communication Panel.
         * @memberof CPC
         */
        this.activeInteractionId = undefined;

        /**
        * @alias currentUser
        * @type {object}
        * @description Holds details of current <a href="global.html#user">user</a>. Value is set once CPC has initialized.<br/>
        * <b>Note:</b> In case user's details change during session and most recent data is needed, call <a href="#getDetails">getDetails</a> like this instead:<br/>
        * <code>await CPC.getDetails('user')</code>.<br/><br/>
        * @memberof CPC
        */
        this.currentUser = undefined;

        /**
        * @alias hostAppEventHandler
        * @type {function}
        * @description Event handler that is called per each event sent by Communication Panel. Initially provided as parameter for <a href="#load">CPC.load</a>. Can be changed at any time.
        * @memberof CPC
        */
        this.hostAppEventHandler = undefined;

        /**
         * @alias isInitialized
         * @type {boolean}
         * @description True when user is logged in and CPC is ready to interact with Communication Panel.
         * @memberof CPC
         */
        this.isInitialized = false;

        /**
         * @alias authenticate_basic
         * @description
         * Authenticate Contact Pro user with basic authentication.<br/><br/>
         * <b>Note: </b> When using this authentication option, be sure to handle user credentials with care. In your application you must prevent credentials getting logged or otherwise getting stored persistently. When possible, use <code>authenticate_token</code> instead.<br/><br/>
         * <b>Recommended:</b> Authentication can also be handled as part of <a href="#load">load</a> call.
         * @async
         * @param {string} sUsername Username
         * @param {string} sPassword Password
         * @returns {boolean} Authentication result
         * @memberof CPC
         */
        this.authenticate_basic = async (sUsername, sPassword) => {
            const fn = 'authenticate_basic';
            if (!_sAuthUrl) {
                Log('WRN', fn, 'Auth endpoint is not set yet.');
                return;
            }
            if (!sUsername || !sPassword || !isString(sUsername || !isString(sPassword))) {
                Log('WRN', fn, 'Authentication failed. Provide both username and password as string.');
                return false;
            }
            let sPasswordUtf8 = '';
            try {
                sPasswordUtf8 = encodeURIComponent(sPassword).replace(/%([0-9A-F]{2})/ig, function (x, n) {
                    return String.fromCharCode(parseInt(n, 16));
                });
            } catch (e) {
                sPasswordUtf8 = sPassword;
            }
            const oFetchConfig = {
                method: 'POST',
                mode: 'cors',
                cache: 'no-cache',
                credentials: 'include',
                headers: { 'AUTHORIZATION': 'ECFAuth', 'Content-Type': 'application/x-www-form-urlencoded' },
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
                body: encodeURI('Authorization=Basic ' + window.btoa(sUsername + ':' + sPasswordUtf8))
            };
            try {
                const authResponse = await fetch(_sAuthUrl, oFetchConfig);
                if (authResponse.status !== 200) {
                    Log('WRN', fn, 'Authentication failed. User will be directed to login scree if possible. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                    return false;
                }
                Log('INF', fn, 'Authentication successful. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                return true;
            } catch (err) {
                Log('ERR', fn, 'Authentication failed. User will be directed to login screen. Endpoint [' + _sAuthUrl + '] error: ' + err.message);
                return false;
            }
        };

        /**
         * @alias authenticate_token
         * @description
         * Authenticate Contact Pro user with OAuth.<br/>
         * Good article about the process <a target="_blank" href="https://www.oauth.com/oauth2-servers/signing-in-with-google/verifying-the-user-info/">https://www.oauth.com/oauth2-servers/signing-in-with-google/verifying-the-user-info/</a><br/><br/>
         *
         * Contact Pro ECF Web Server assumes that the Issuer (token <code>iss</code> claim) implements OAuth <code>{iss}/.well-known/openid-configuration</code> endpoint which returns <code>user_info</code> URL.<br/>
         * ECF server calls <code>user_info</code> URL to request verification for token.<br/><br/>
         *
         * Upon successful token verification, the <code>user_info</code> endpoint must return <code>200 OK</code> and payload <code>{sub: '', email: ''}</code> where values correspond with Contact Pro user's Certificate Subject and Email values.<br/><br/>
         * ECF server finally identifies Contact Pro user based on <code>sub</code> and <code>email</code>, and grants session cookie, allowing browser to access resources behind ECF Web Server.<br/><br/>
         * <b>Recommended:</b> Authentication can also be handled as part of <a href="#load">load</a> call.
         * @async
         * @param {string} authToken OAuth token
         * @returns {boolean} Authentication result
         * @memberof CPC
         */
        this.authenticate_token = async (authToken) => {
            const fn = 'authenticate_token';
            if (!_sAuthUrl) {
                Log('WRN', fn, 'Auth endpoint is not set yet.');
                return;
            }
            const oFetchConfig = {
                method: 'POST',
                mode: 'cors',
                cache: 'no-cache',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + authToken
                },
                redirect: 'follow',
                referrerPolicy: 'no-referrer'
            };
            try {
                const authResponse = await fetch(_sAuthUrl, oFetchConfig);
                if (authResponse.status !== 200) {
                    Log('WRN', fn, 'Authentication failed. User will be directed to login scree if possible. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                    return false;
                }
                Log('INF', fn, 'Authentication successful. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                return true;
            } catch (err) {
                Log('ERR', fn, 'Authentication failed. User will be directed to login screen. Endpoint [' + _sAuthUrl + '] error: ' + err.message);
                return false;
            }
        };

        /**
         * @alias callOut
         * @description Sends a call out request to Communication Panel.
         * @async
         * @param {string} destinationNumber Destination phone number.
         * @param {string=} sourceQueueNumber Queue number to be used as <i>Visible A Number</i> for the call.<br/>
         * <b>Note:</b>User must have appropriate serve rights to the Queue.<br/>
         * <b>Tip:</b>Check list of user's queues first with <a href="#getCurrentUserQueues">getCurrentUserQueues</a>
         * @returns {object|false} Phone call object, or false if creating a call failed.
         * @memberof CPC
         */
        this.callOut = async (destinationNumber, sourceQueueNumber) => {
            const fn = 'callOut';
            if (!destinationNumber) {
                Log('WRN', fn, 'Must provide a valid [destinationNumber]');
                return false;
            }
            if (sourceQueueNumber && !isString(sourceQueueNumber)) {
                Log('WRN', fn, 'Must provide [sourceQueueNumber] as string');
                return false;
            }
            if (sourceQueueNumber) {
                const phoneQueues = await window.CPC.getCurrentUserQueues('phone');
                const isValidSource = phoneQueues.find(queue => queue.addresses?.length > 0 && queue.addresses.find(item => item.address === sourceQueueNumber));
                if (!isValidSource) {
                    Log('WRN', fn, 'Must provide [sourceQueueNumber] to which User has rights for');
                    return false;
                }
            }
            Log('INF', fn, 'Calling [' + destinationNumber + '] from: [' + sourceQueueNumber + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'outbound',
                value: {
                    channel: 'phone',
                    to: destinationNumber,
                    from: sourceQueueNumber
                }
            });
        };

        /**
         * @alias callState
         * @description Change state of ongoing phone call.
         * @async
         * @param {'startRecording'|'stopRecording'|'hold'|'unhold'|'mute'|'unmute'} action State change to be performed on currently ongoing phone call.
         * @param {string=} interactionId Id of <a href="global.html#interaction">interaction</a> that should be acted on. Defaults to user's current active <a href="global.html#interaction">interaction</a> being viewed in Communication Panel.
         * @returns {false|Object} Changed <a href="global.html#interaction">interaction</a> object, or false if action failed.
         * @memberof CPC
         */
        this.callState = async (action, interactionId) => {
            const fn = 'callState';
            const values = ['startRecording', 'stopRecording', 'hold', 'unhold', 'mute', 'unmute'];
            if (!values.includes(action)) {
                Log('WRN', fn, 'Invalid parameter value. Possible values are: ' + values.join('|'));
                return false;
            }
            if (interactionId && !isUid(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            if (!interactionId && !this.activeInteractionId) {
                Log('WRN', fn, 'InteractionId not provided, and no active/in-view interaction. Canceling request');
                return false;
            }
            const _interactionId = interactionId || this.activeInteractionId;
            Log('INF', fn, 'State change [' + action + '] for [' + _interactionId + '] interaction');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: fn,
                interactionId: _interactionId,
                value: action
            });
        };

        /**
         * @alias consult
         * @description In context of ongoing <a href="global.html#interaction">interaction</a> currently selected in Communication Panel (or in context of explicitly defined interaction), create a consultation interaction.<br/>
         * The original phone call is put on hold, and a new phone call is created. Later the calls can be joined by calling <a href="#joinCalls">joinCalls</a>.
         * Possible for <code>phone</code> and <code>chat</code> type interactions.
         * @async
         * @param {string} to Address or number of destination Queue or User.
         * @param {string=} interactionId Id of the ongoing interaction.
         * @returns {object|false} Created <a href="global.html#interaction">interaction</a> object, or false if action failed.
         * @memberof CPC
         */
        this.consult = async (to, interactionId) => {
            const fn = 'consult';
            if (!isString(to)) {
                Log('WRN', fn, 'Must provide a valid [to]');
                return false;
            }
            if (interactionId && !isString(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            Log('INF', fn, 'To [' + to + ']');
            if (!this.activeInteractionId) {
                Log('ERR', fn, 'No active interaction id to be used as source for consultation call. Ensure there is an active incoming or outgoing phone call first, and that in Communication Panel the user has seleced a phone call..');
                return false;
            }
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'consult',
                interactionId: this.activeInteractionId,
                value: {
                    to
                }
            });
        };

        /**
         * @alias dtmf
         * @description Send DTMF tone to current active <a href="global.html#interaction">interaction</a> being viewed in Communication Panel. This works only with <code>phone</code> channel.
         * @async
         * @param {'0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'A'|'B'|'C'|'D'|'*'|'#'} tone The tone to be sent.
         * @param {string=} interactionId Specify ongoing phone <a href="global.html#interaction">interaction</a> for which tone is sent.
         * @returns {false|Object} Corresponding <a href="global.html#interaction">interaction</a> object, or false if action failed.
         * @memberof CPC
         */
        this.dtmf = async (tone, interactionId) => {
            const fn = 'dtmf';
            if (!tone) {
                Log('WRN', fn, 'Must provide a valid [tone]');
                return false;
            }
            if (interactionId && !isString(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'dtmf',
                interactionId: interactionId || undefined,
                value: {
                    content: tone
                }
            });
        };

        /**
        * @alias getCurrentUserQueues
        * @description Get the currently logged on user's queue list.
        * @async
        * @param {'phone'|'chat'|'email'=} sChannelType Optionally filter by channel.
        * @returns {Array} Array of <a href="global.html#queue">queue</a>(s).
        * @memberof CPC
        */
        this.getCurrentUserQueues = async (sChannelType) => {
            const queuesResponse = await window.CPC.getDetails('queues');
            let queues = queuesResponse.payload?.value;
            if (sChannelType) {
                queues = queues.filter(queue => queue.type === sChannelType);
            }
            return queues;
        };

        /**
         * @alias getDetails
         * @description Returns details of defined subject.
         * @async
         * @param {'user'|'interaction'|'interactions'|'queue'|'queues'|'transcript'|'activeExtension '|'activeInteraction'| string} subject Subject of details request.
         * @returns {object} Object including details of the given subject. <a target="_blank" href="../CPExtInterface.html#detail">In CPExtInterface schema, see "detail".</a>
         * @memberof CPC
         */
        this.getDetails = async (subject) => {
            const fn = 'getDetails';
            const values = ['user', 'interaction', 'interactions', 'queue', 'queues', 'transcript', 'activeExtension', 'activeInteraction'];
            if (!values.includes(subject) && subject.length !== 32) {
                Log('WRN', fn, 'Invalid parameter value. Possible values are: ' + values.join('|') + '|<interaction_id>');
                return false;
            }
            Log('INF', fn, 'Getting details of [' + subject + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'detail',
                value: subject
            });
        };

        /**
        * @alias getTenantBaseUrl
        * @description Get Contact Pro tenant/installation base URL. This is provided initially as parameter for <a href="#load">load</a>.
        * @returns {string} URL.
        * @memberof CPC
        */
        this.getTenantBaseUrl = () => {
            return _sTenantBaseUrl;
        };

        /**
         * @alias hasOngoingInteraction
         * @description Check if user has any ongoing <a href="global.html#interaction">interaction</a>(s) in Communication Panel.
         * @param {'phone'|'chat'|'email'=} channelType Optionally check specified channel type only.
         * @returns {boolean} True when there is at least one ongoing interaction.
         * @memberof CPC
         */
        this.hasOngoingInteraction = (channelType) => {
            const fn = 'hasOngoingInteraction';
            const values = ['phone', 'chat', 'email'];
            if (channelType && !values.includes(channelType)) {
                Log('WRN', fn, `Invalid parameter value. Possible values are: ${values.join('|')}`);
                return false;
            }
            if (channelType) {
                for (const interaction in _oInteractions) {
                    if (interaction.channel_type === channelType) return true;
                }
            } else {
                return _oInteractions.size > 0;
            }
        };

        /**
         * @alias hasOngoingInteractionOfType
         * @deprecated <a href="#hasOngoingInteraction">Use hasOngoingInteraction insted</a>
         * @description Check if user has ongoing interaction(s) of specific type.
         * @param {'phone'|'chat'|'email'} channelType Channel
         * @returns {boolean} True when there is at least one ongoing interaction.
         * @memberof CPC
         */
        this.hasOngoingInteractionOfType = (channelType) => {
            return this.hasOngoingInteraction(channelType);
        };

        /**
         * @alias init
         * @description Sends initialization request to Communication Panel. As result, Communication Panel will start sending events and accepting commands from CPC.<br/><br/>
         * <b>Note:</b> This is needed only if <a href="#load">load</a> is not used to automatically inject Communication Panel.<br/>
         * <b>Recommended:</b> Use <a href="#load">load</a> instead. It internally handles calling <code>init</code> so you don't need to.
         * @returns {void} No return value.
         * @memberof CPC
         */
        this.init = () => {
            const fn = 'init';
            Log('INF', fn, 'Sending init command. Note: Communication Panel caches this and sends response once user has logged in');
            sendToCommunicationPanel({
                id: _sInitRequest,
                type: 'init',
                payload: false
            });
        };

        /**
         * @alias interaction
         * @description Perform a state changing action on the current active <a href="global.html#interaction">interaction</a> being viewed in Communication Panel.
         * @async
         * @param {'accept'|'reject'|'pick'|'handle'|'hangup'} action Type of action to perform.
         * @param {string=} interactionId Specify ID of ongoing interaction which should be acted upon.
         * @returns {Object|false} Changed <a href="global.html#interaction">interaction</a> object, or false if action failed.
         * @memberof CPC
         */
        this.interaction = async (action, interactionId) => {
            const fn = 'interaction';
            const values = ['reject', 'accept', 'hangup', 'handle', 'pick'];
            if (!values.includes(action)) {
                Log('WRN', fn, `Invalid parameter value. Possible values are: ${values.join('|')}`);
                return false;
            }
            if (interactionId && !isUid(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            if (!interactionId && !this.activeInteractionId) {
                Log('WRN', fn, 'InteractionId not provided, and no active/in-view interaction. Canceling request');
                return false;
            }
            const _interactionId = interactionId || this.activeInteractionId;
            Log('INF', fn, `Requesting state change [${action}] for [${interactionId}]`);
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'interaction',
                interactionId: _interactionId,
                value: action
            });
        };

        /**
         * @alias joinCalls
         * @description Joins currently active original inbound or outbound phone call <a href="global.html#interaction">interaction</a> and corresponding consultation call.<br/>
         * This drops the agent/user from the ongoing calls, connects other parties in a joined phone call.<br/>
         * <b>Note:</b> After <code>joinCalls</code> completes, phone call signaling and voice still remain connected via Sinch Contact Pro backend but can no longer be controlled by CPC.
         * @async
         * @returns {object|false} The <a href="global.html#interaction">interaction</a> object of phone call from which the agent/user left, or false if action failed.
         * @memberof CPC
         *
         */
        this.joinCalls = async () => {
            const fn = 'joinCalls';
            if (!this.activeInteractionId) {
                Log('ERR', fn, 'No active currently selected phone calls to join. For this command there needs to be an either incoming or outgoing phone call, and a consultation call. In Communication Panel user must have selected a ongoing phone call.');
                return false;
            }
            Log('INF', fn, 'Joining calls, activeInteractionId: [' + this.activeInteractionId + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'join',
                interactionId: this.activeInteractionId
            });
        };

        /**
         * @alias load
         * @description Load Communication Panel into host application. Optionally provide authentication for automated user login.<br/>
         * <b>Tip:</b> It's easy to try this on the CPC Playground page. See link in top banner.
         * @param {Object} config Object containing initial configuration for CPC.
         * @param {function} config.eventHandler Defined by Client Application.
         * @param {string} config.tenantBaseUrl Contact Pro tenant/installation specific base-URL.
         * @param {string|Object} config.parentElement Provide container element ID or reference to container element. An <code>iframe</code> element containing Communication Panel is injected into this element.
         * @param {boolean=} config.enableDebugLog Set <code>true</code> to enable debug logging.
         * @param {boolean=} config.denyPopout Set <code>true</code> to deny user from opening CP in pop-out window. This also disables My Conversations view, and overrides any User Settings Template -level settings configured in System Configurator.
         * @param {number=} config.minWidth Set width limit (interpreted in pixels) to activate My Conversations view. This overrides User Settings Template -level settings configured in System Configurator.
         * @param {number=} config.minHeight Set height limit (interpreted in pixels) to activate My Conversations view. This overrides User Settings Template -level settings configured in System Configurator.
         * @param {boolean=} config.enableChannelStatusUpdates When enabled, CPC forwards channel_status updates to client event handler.
         * @param {Object=} config.authentication Authenticate and log user in automatically.
         * @param {Object=} config.authentication.oAuth OAuth
         * @param {string} config.authentication.oAuth.token Token
         * @param {Object=} config.authentication.basic basic authentication
         * @param {string} config.authentication.basic.userName Username
         * @param {string} config.authentication.basic.password Password
         * @async
         * @returns {boolean} Load result.
         * @memberof CPC
         */
        this.load = async (config) => {
            const iFrameId = _sProdName + '-frame';
            if (document.getElementById(iFrameId) !== null && window.CommunicationPanelControl) {
                Log('WRN', 'load', _sProdName + ' is already loaded. Will not load a second instance.');
                return false;
            }
            if (
                typeof config !== 'object' ||
                config === null ||
                !isFunction(config.eventHandler) ||
                (config.enableDebugLog !== undefined && !isBoolean(config.enableDebugLog)) ||
                !isString(config.tenantBaseUrl) ||
                (!config.parentElement)
            ) {
                Log('WRN', 'load', 'One or more config parameters are incorrect, aborting load.');
                return false;
            }
            this.hostAppEventHandler = config.eventHandler; // Store to global public variable
            _bDebug = config.enableDebugLog || false;
            if (!config.tenantBaseUrl.endsWith('/')) {
                config.tenantBaseUrl += '/';
            }
            _sTenantBaseUrl = config.tenantBaseUrl; // Store to global private variable
            _sAuthUrl = (_sDevTenant || _sTenantBaseUrl) + 'ecfs/authentication/'; // Note! Remember to include last trailing slash - Otherwise pre-flight OPTIONS is not routed to CorsFilter
            const path = _sDevTenant ? '/' : 'ecf/latest/communicationpanel/';
            let cpUrl = _sTenantBaseUrl + path + 'embedded.html?salesforce=true'; // Utilize the built-in salesforce integration, as this triggers CP to start notifying parent window
            if (config.responsive) cpUrl += '&responsive=true'; // Applies only to 22Q3 release
            if (config.denyPopout) cpUrl += '&denyPopout=true';
            if (Number.isInteger(config.minWidth) && config.minWidth > 0) cpUrl += '&minWidth=' + config.minWidth;
            if (Number.isInteger(config.minHeight) && config.minHeight > 0) cpUrl += '&minHeight=' + config.minHeight;
            if (_bDebug) cpUrl += '&sap-ui-debug=true';
            if (config.enableChannelStatusUpdates) {
                _bChannelStatusUpdatesEnabled = true;
            }
            if (config.authentication?.oAuth?.token) {
                await this.authenticate_token(config.authentication.oAuth.token);
            } else if (config.authentication?.basic?.userName && config.authentication?.basic?.password) {
                const basic = config.authentication.basic;
                await this.authenticate_basic(basic.userName, basic.password);
            }
            if (config.authentication?.basic?.password) {
                // Immediately after auth, overwrite password so it won't appear in possible debug logs.
                config.authentication.basic.password = '**********';
            }

            Log('TRC', 'load', 'Embedding Communication Panel from [' + cpUrl + ']. Debug=[' + _bDebug + ']');
            const i = document.createElement('iframe');
            i.setAttribute('src', cpUrl);
            i.setAttribute('id', iFrameId);
            i.setAttribute('allow', 'microphone');
            i.style.width = '100%';
            i.style.height = '100%';
            i.style.border = '0';
            i.onload = () => {
                _sCpOrigin = new URL(i.src).origin;
                startMessageListener();
                Log('INF', 'load', 'Loaded. Host app origin [' + window.origin + ']. Configuration=[' + JSON.stringify(config) + ']');
                this.hostAppEventHandler({
                    // Fabricate an event to notify customer event handler of when CPC has successfully loaded Communication Panel into <code>iframe</code>
                    id: 'cpc-onload',
                    type: 'status',
                    payload: {
                        attribute: 'onload',
                        value: 'Communication Panel loaded in iframe'
                    }
                });
                this.init();
            };
            try {
                _oParentElement = isString(config.parentElement) ? document.getElementById(config.parentElement) : config.parentElement;
                if (_oParentElement === null) {
                    Log('ERR', 'load', 'Could not load Communication Panel into iframe. Could not find defined parent element [' + config.parentElement + ']');
                    return false;
                }
                _oParentElement.appendChild(i);
                _oCpFrame = i;
                return true;
            } catch (e) {
                Log('ERR', 'load', 'Could not load Communication Panel into iframe. Exception=[' + e.message + ']');
                return false;
            }
        };

        /**
         * @alias message
         * @description Send a textual message to active <code>chat</code> <a href="global.html#interaction">interaction</a>. Works also with <b>sms</b> chats.
         * @async
         * @param {string} message Message content
         * @param {string=} interactionId Specific interaction for which the message should be sent.
         * @returns {false|Object} Corresponding <a href="global.html#interaction">interaction</a> object, or false if action failed.
         * @memberof CPC
         */
        this.message = async (message, interactionId) => {
            const fn = 'message';
            if (!message) {
                Log('WRN', fn, 'Must provide a valid [message]');
                return false;
            }
            if (interactionId && !isString(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'message',
                interactionId: interactionId || undefined,
                value: {
                    content: message
                }
            });
        };

        /**
         * @alias ongoingInteractions
         * @description Returns a <code>Map</code> containing all currently ongoing <a href="global.html#interaction">interaction</a>(s) cached by CPC. These interactions include the extra timestamps appended by CPC.
         * @returns {Map<string, object>} Key = InteractionId, Value = <a href="global.html#interaction">interaction</a>
         * @memberof CPC
         */
        this.ongoingInteractions = () => {
            return _oInteractions;
        };

        /**
         * @alias sendEmail
         * @description Create a new email.
         * @async
         * @param {Object} email Object containing following properties
         * @param {Array} email.to Array of destination email addresses.
         * @param {boolean} email.direct If <code>true</code>, email is sent without user interaction. When <code>true</code>, value for all optional parameters must be provided.
         * @param {string=} email.from Specific sender address can be defined.
         * @param {string=} email.subject Subject for email
         * @param {string=} email.content Content of email message.
         * @returns {object|false} Created email <a href="global.html#interaction">interaction</a> object, or false on failure.
         * @memberof CPC
         */
        this.sendEmail = async (email) => {
            const fn = 'sendEmail';
            if (!isArray(email.to)) {
                Log('WRN', fn, 'Parameter [to] must be an Array containing destination email addresses');
                return false;
            }
            if (!isBoolean(email.direct)) {
                Log('WRN', fn, 'Must provide a boolean value for parameter [direct]');
                return false;
            }
            if (email.from && !isString(email.from)) {
                Log('WRN', fn, 'Must provide a string value for parameter [from]');
                return false;
            }
            if (email.subject && !isString(email.subject)) {
                Log('WRN', fn, 'Must provide a string value for parameter [subject]');
                return false;
            }
            if (email.direct === true && (!email.content || !email.subject)) {
                Log('WRN', fn, 'Parameters [subject, content] must have value when parameter [direct] is true');
                return false;
            }
            Log('INF', fn, 'Starting email with parameters [' + JSON.stringify(email) + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'outbound',
                value: { channel: 'email', ...email }
            });
        };

        /**
         * @alias sendSMS
         * @description Start a one-to-one SMS message based chat.
         * @async
         * @param {Object} msg Object containing following properties
         * @param {string} msg.to Destination number
         * @param {boolean} msg.direct If <code>true</code>, SMS chat is started and first message sent without user interaction. When <code>true</code>, all other optional parameters require values as well.
         * @param {string=} msg.from Queue number/address of message. User must have serve right for the Queue.
         * @param {string=} msg.content Content of SMS message.
         * @returns {object|false} Created SMS <a href="global.html#interaction">interaction</a> object, or false if creation failed.
         * @memberof CPC
        */
        this.sendSMS = async (msg) => {
            const fn = 'sendSMS';
            if (!msg.to) {
                Log('WRN', fn, 'Must provide value for [to]');
                return false;
            }
            if (!isBoolean(msg.direct)) {
                Log('WRN', fn, 'Must provide a boolean value for parameter [direct]');
                return false;
            }
            if (msg.direct === true && !msg.from) {
                Log('WRN', fn, 'Parameter [from] must have value when parameter [direct] is true');
                return false;
            }
            if (msg.direct === true && !msg.content) {
                Log('WRN', fn, 'Parameter [content] must have value when parameter [direct] is true');
                return false;
            }
            Log('INF', fn, 'Starting SMS chat with parameters [' + JSON.stringify(msg) + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'outbound',
                value: { channel: 'sms', ...msg }
            });
        };

        /**
         * @alias startWhatsAppChat
         * @description Start a new WhatsApp chat.
         * @async
         * @param {Object} chat Object containing following properties
         * @param {string} chat.to Destination number
         * @param {boolean} chat.direct If <code>true</code>, value for all optional parameters must be provided. When <code>true</code>, chat is started and first message is sent without user interaction.
         * @param {string=} chat.from Queue number/address of message. User must have serve right for the Queue.
         * @param {string=} chat.content Content of first WhatsApp message sent. Note: Delivery of this message depends on current consent status of destination number. Delivery is not guaranteed.
         * @param {string=} chat.defaultReplyTemplateId Specific WhatsApp template to use, which is sent when invoking first WhatsApp chat towards number for which Contact Pro doesn't have stored consent yet.
         * @returns {object|false} Created WhatsApp chat <a href="global.html#interaction">interaction</a> object, or false if creation failed.
         * @memberof CPC
         */
        this.startWhatsAppChat = async (chat) => {
            const fn = 'startWhatsAppChat';
            if (!chat.to) {
                Log('WRN', fn, 'Must provide value for [to]');
                return false;
            }
            if (!isBoolean(chat.direct)) {
                Log('WRN', fn, 'Must provide a boolean value for parameter [direct]');
                return false;
            }
            if (chat.direct === true && !chat.from) {
                Log('WRN', fn, 'Parameter [from] must have value when parameter [direct] is true');
                return false;
            }
            if (chat.direct === true && !chat.content) {
                Log('WRN', fn, 'Parameter [content] must have value when parameter [direct] is true');
                return false;
            }
            if (chat.defaultReplyTemplateId && !isUid(chat.defaultReplyTemplateId)) {
                Log('WRN', fn, 'Must provide a string UID value for parameter [templateId]');
                return false;
            }
            Log('INF', fn, 'Starting WhatsApp chat to [' + chat.to + '] with template id [' + chat.defaultReplyTemplateId + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'outbound',
                value: { channel: 'whatsapp', ...chat }
            });
        };

        /**
         * @alias transfer
         * @description Transfer ongoing <a href="global.html#interaction">interaction</a>. Possible in <code>phone</code> and <code>chat</code> channels.
         * @async
         * @param {string} to Address or number of destination queue or user.
         * @param {string=} interactionId Id of the ongoing interaction.
         * @returns {object|false} Created WhatsApp <a href="global.html#interaction">interaction</a> object, or false if creation failed.
         * @memberof CPC
         */
        this.transfer = async (to, interactionId) => {
            const fn = 'transfer';
            if (!isString(to)) {
                Log('WRN', fn, 'Must provide a valid [to]');
                return false;
            }
            if (interactionId && !isString(interactionId)) {
                Log('WRN', fn, 'Must provide a valid [interactionId]');
                return false;
            }
            Log('INF', fn, 'To [' + to + ']');
            return await this.xdmSendAction({
                cpcFn: fn,
                command: 'transfer',
                interactionId: interactionId || undefined,
                value: {
                    to
                }
            });
        };

        /**
         * @alias unload
         * @description
         * Unload performs two steps:<br/>
         * 1. Sends request to server to invalidate current authentication cookie -> Server logs out currently logged in user.<br/>
         * 2. CPC deletes the <code>iframe</code> element that contains Communication Panel.<br/>
         * <b>Note:</b> This is a 'hard logout' which does not take into account possibly ongoing <a href="global.html#interaction">interaction</a>(s) such as phone calls or chats. If needed, call <code>hasOngoingInteraction()</code> first. If user needs to log back in, call <code>load</code> to re-inject Communication Panel.
         * @async
         * @returns {boolean} Unload result.
         * @memberof CPC
         */
        this.unload = async () => {
            const fn = 'logOut';
            if (!_sAuthUrl) {
                Log('WRN', fn, 'Auth endpoint is not set yet.');
                return;
            }
            const oFetchConfig = {
                method: 'DELETE',
                mode: 'cors',
                cache: 'no-cache',
                credentials: 'include',
                redirect: 'follow',
                referrerPolicy: 'no-referrer'
            };
            try {
                const authResponse = await fetch(_sAuthUrl, oFetchConfig);
                if (authResponse.status !== 200) {
                    Log('WRN', fn, 'Deauthentication failed. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                }
                Log('INF', fn, 'Deauthenticated successfully. Endpoint [' + _sAuthUrl + '] responded HTTP [' + authResponse.status + ']');
                await new Promise(resolve => setTimeout(resolve, 1000));
                const frame = document.getElementById(_sProdName + '-frame');
                _oParentElement.removeChild(frame);
                Log('INF', fn, 'Communication Panel iframe removed from DOM - Unload complete');
                return true;
            } catch (err) {
                Log('ERR', fn, 'Unloading failed. Endpoint [' + _sAuthUrl + '] error: ' + err.message);
                return false;
            }
        };

        /**
         * @alias xdmSendAction
         * @description Helper for sending <code>action</code> messages to Communication Panel.<br/><br/>
         * <b>Note:</b> Usually there is no need to call this directly.<br/>
         * In CPC there is a convenience method per each capability/feature of the underlying <a target="_blank" href="../CPExtInterface.html#message-schema">CPExtInterface</a>. Convenience methods handle calling <code>xdmSendAction</code> internally, so you don't have to.
         * @async
         * @param {object} payload Object containing documented attributes and values.
         * @returns {object} Response payload value from Communication Panel.
         * @memberof CPC
         */
        this.xdmSendAction = async (payload) => {
            const fn = 'xdmSendAction';
            if (!this.isInitialized) {
                Log('WRN', fn, 'CPC is not initialized to interact with Communication Panel. Please make sure to call load() first, and that user is authenticated & logged in first.');
                return;
            }
            return await new Promise(resolve => {
                try {
                    JSON.parse(JSON.stringify(payload));
                } catch (e) {
                    Log('WRN', fn, 'Provided payload is invalid. Aborting action');
                    resolve(false);
                }
                const pendingAction = {
                    action: {
                        id: payload.cpcFn + '-action-' + _iActionRequestCount,
                        type: 'action',
                        payload
                    },
                    response: null,
                    waitCount: 0
                };
                _oPendingActions[pendingAction.action.id] = pendingAction;
                _iActionRequestCount += 1;

                const responseWaiter = () => {
                    pendingAction.waitCount += 1;
                    if (pendingAction.response) {
                        Log('DBG', 'responseWaiter', 'Action=[' + JSON.stringify(pendingAction.action) + '], Response=[' + JSON.stringify(pendingAction.response) + ']');
                        const data = pendingAction.response;
                        delete _oPendingActions[pendingAction.action.id];
                        resolve(data);
                    } else if (pendingAction.waitCount === _iActionMaxWaitCount) {
                        Log('ERR', 'responseWaiter', 'No response for action: ' + JSON.stringify(pendingAction.action));
                        delete _oPendingActions[pendingAction.action.id];
                        resolve(false);
                    } else {
                        setTimeout(() => {
                            responseWaiter(pendingAction.action.id);
                        }, 50);
                    }
                };

                Log('TRC', fn, 'Sending action: ' + JSON.stringify(pendingAction.action));
                sendToCommunicationPanel(pendingAction.action);
                responseWaiter();
            });
        };

        /**
         * @namespace
         * @description <b>window.CPC.RI</b> allows to easily access Contact Pro Restful Interfaces, such as the RMI, in current user context.
         * @memberof CPC
         * @alias RI
         */
        this.RI = new function () {
            // Fetch API config to use with Restful Interfaces:
            const getRiFetchConfig = (method, body) => {
                return {
                    method,
                    body,
                    mode: 'cors',
                    cache: 'no-cache',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    referrerPolicy: 'no-referrer'
                };
            };

            /**
             * @alias request
             * @description Call Restful Interfaces easily, in context of current user.
             * @async
             * @param {('RCI'|'CMI'|'DPI'|'OBI'|'RTI'|'RAI'|'LRI'|'RMI')} api The destination API
             * @param {('GET'|'POST'|'PUT'|'DELETE')} method HTTP verb
             * @param {string} resource For example '/users' of the RCI API.
             * @param {object=} body Request body (for POST and PUT)
             * @returns {object} When successful, function returns the JSON returned by the API. When failed, an object describing failure is returned.
             * @memberof RI
             */
            this.request = async (api, method, resource, body) => {
                const fn = 'request';
                const apis = ['RCI', 'CMI', 'DPI', 'OBI', 'RTI', 'RAI', 'LRI', 'RMI'];
                api = api.toUpperCase();
                if (!apis.includes(api)) {
                    Log('WRN', fn, 'API [' + api + '] is unknown. Use one of the following: ' + apis.toString());
                    return;
                }
                api = api.toLowerCase();
                if (!window.CPC.isInitialized && !window.CommunicationPanelControl.isInitialized) {
                    Log('WRN', fn, 'CPC is not initialized to interact with Communication Panel. Please make sure to call load() first, and that user is authenticated & logged in first.');
                    return;
                } else {
                    this.CPC = window.CPC || window.CommunicationPanelControl;
                }
                if (!resource.startsWith('/')) {
                    resource = '/' + resource;
                }
                if (resource.endsWith('/')) {
                    resource.slice(0, -1);
                }
                const url = this.CPC.getTenantBaseUrl() + 'ecfs/RI/' + api + resource;
                try {
                    const response = await fetch(url, getRiFetchConfig(method, body));
                    if (response.ok) {
                        Log('INF', fn, '[' + response.status + ']: [' + url + ']');
                        return (response.status === 200) ? await response.json() : true;
                    } else {
                        Log('WRN', fn, 'Restful Interfaces (RI) API [' + api + '] resource [' + resource + '] responded HTTP [' + response.status + ']. Full URL of request: ' + url);
                        return {
                            error: true,
                            api,
                            method,
                            url,
                            status: response.status,
                            body
                        };
                    }
                } catch (err) {
                    Log('ERR', fn, 'Request failed: ' + err.message);
                    return {
                        error: true,
                        api,
                        method,
                        url,
                        status: 'error',
                        body
                    };
                }
            };
        }();

        // Below are few added convenience functions which utilize Restful Interfaces.
        // https://docs.cc.sinch.com/cloud/api.html
        // Consumer of this library can extend, and add more of these convenience functions into CPC-customer-extension.js.
        /**
         * @alias setPresence
         * @description Uses <a href="#request">request</a> to call RMI <a href="https://docs.cc.sinch.com/onpremise/fp19/api/RMI.html#agents__agentid__presences__presenceid__put">PUT /agents/{agentId}/presences/{presenceId}</a> to set <a href="global.html#user">user</a>'s presence profile.
         * @async
         * @param {string} sProfile Profile id or name.<br/><b>Tip:</b> Check current <a href="global.html#user">user</a>'s <code>presence_profiles</code> from <a href="CPC.html#currentUser">CPC.currentUser</a>.
         * @returns {object} Result of profile change. <b>Note:</b> Client code event handler is fired with same value.
         *
         * @memberof RI
         */
        this.setPresence = async (sProfile) => {
            const fn = 'setPresence';
            if (!this.isInitialized || !this.currentUser.id) {
                Log('WRN', fn, 'Cannot set profile. CPC is not initialized to interact with Communication Panel. Please make sure to call load() first, and that user is authenticated & logged in first.');
                return false;
            }
            const CPC = window.CPC || window.CommunicationPanelControl;
            let oReturn = {
                id: 'cpc-profileChange'
            };
            const oProfiles = await CPC.RI.request('RMI', 'GET', `/agents/${this.currentUser.id}/presences/`);
            if (oProfiles.error) {
                Log('WRN', fn, 'Cannot get user profiles');
                oReturn = { ...oReturn, error: oProfiles };
                this.hostAppEventHandler(oReturn);
                return oReturn;
            }
            const oProfile = oProfiles.find(p => isUid(sProfile) ? p.id === sProfile : p.name === sProfile);
            if (!oProfile) {
                Log('WRN', fn, 'Cannot find profile by name: ' + sProfile);
                oReturn = { ...oReturn, error: 'Unknown profile name' };
                this.hostAppEventHandler(oReturn);
                return oReturn;
            }
            const oResult = await CPC.RI.request('RMI', 'PUT', `/agents/${this.currentUser.id}/presences/${oProfile.id}`, JSON.stringify(oProfile));
            if (oResult.error) {
                Log('WRN', fn, 'Profile [' + oProfile.id + ']:[' + oProfile.name + '] was not set: ' + JSON.stringify(oResult));
                oReturn = { ...oReturn, error: oResult };
            } else {
                CPC.currentUser.presence = oProfile.id;
                Log('INF', fn, 'Profile [' + oProfile.id + ']:[' + oProfile.name + '] is set.');
                // When invoked by RMI /presences, CP doesn't send event of the changed state. Simulate event like it was sent as result of user doing the same thing in UI:
                oReturn = {
                    ...oReturn,
                    ...{
                        type: 'status',
                        payload: {
                            attribute: 'profile',
                            value: oProfile
                        }
                    }
                };
            }
            this.hostAppEventHandler(oReturn);
            return oReturn;
        };

        /**
         * @alias setReady
         * @description Uses <a href="#request">request</a> to call RMI <a href="https://docs.cc.sinch.com/onpremise/fp19/api/RMI.html#agents__agentid__readystate_put">PUT /agents/{agentId}/readyState</a> to set user's Ready-state.
         * @async
         * @param {boolean} bReady True=Ready, False=NotReady.
         * @returns {object} Result of ready-state change. Client code event handler is fired with same value.
         * @memberof RI
         */
        this.setReady = async (bReady) => {
            const fn = 'setReady';
            if (!isBoolean(bReady)) {
                Log('WRN', fn, 'Must provide boolean parameter value.');
                return false;
            }
            if (!this.isInitialized || !this.currentUser.id) {
                Log('WRN', fn, 'Cannot set ready state. CPC is not initialized to interact with Communication Panel. Please make sure to call load() first, and that user is authenticated & logged in first.');
                return false;
            }
            const CPC = window.CPC || window.CommunicationPanelControl;
            let oReturn = {
                id: 'cpc-readyState'
            };
            const oResult = await CPC.RI.request('RMI', 'PUT', `/agents/${this.currentUser.id}/readyState/`, JSON.stringify({
                readyState: bReady ? 'Ready' : 'NotReady'
            }));
            if (oResult.error) {
                Log('WRN', fn, 'Could not switch to [' + bReady ? 'Ready' : 'NotReady' + '] state.');
                oReturn = { ...oReturn, error: oResult };
            } else {
                Log('INF', fn, 'Switched to [' + bReady ? 'Ready' : 'NotReady' + '].');
                // When invoked by RMI /readyState, CP doesn't send event of the changed state. Simulate event like it was sent as result of user doing the same thing in UI:
                const desiredValue = bReady ? 'ready' : 'not_ready';
                oReturn = {
                    ...oReturn,
                    ...{
                        type: 'status',
                        payload: {
                            attribute: 'work_status',
                            value: oResult ? desiredValue : 'error'
                        }
                    }
                };
            }
            this.hostAppEventHandler(oReturn);
            return oReturn;
        };
    }();

    if (window.CommunicationPanelControl && typeof window.CommunicationPanelControl.isInitialized === 'boolean') {
        console.warn('CPC is already loaded and registered into window scope. Cannot load it more than once');
    } else {
        window.CommunicationPanelControl = CPC;
        if (window.CPC) {
            console.log('Window.CPC already exists. Will not overwrite. Try using window.CommunicationPanelControl instead.');
        } else {
            window.CPC = CPC;
        }
    }
})();

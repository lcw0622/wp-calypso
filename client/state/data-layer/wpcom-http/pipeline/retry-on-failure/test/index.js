/**
 * External dependencies
 */
import deepFreeze from 'deep-freeze';
import { expect } from 'chai';
import { spy } from 'sinon';
import { merge } from 'lodash';

/**
 * Internal dependencies
 */
import { useFakeTimers } from 'test/helpers/use-sinon';
import { http } from 'state/data-layer/wpcom-http/actions';
import { retryOnFailure as rof } from '../';
import { noRetry, simpleRetry, exponentialBackoff } from '../policies';

const retryOnFailure = rof();
const retryWithDelay = delay => rof( { getDelay: () => delay } );

const failer = { type: 'FAIL' };
const nextError = { fail: 'failed big time' };
const succeeder = { type: 'SUCCEED' };

const getSites = deepFreeze( http( {
	method: 'GET',
	path: '/sites',
	apiVersion: 'v1',
	onSuccess: succeeder,
	onFailure: failer,
} ) );

const withRetries = retryCount => actionOrInbound =>
	undefined !== actionOrInbound.originalRequest
		? merge( actionOrInbound, { originalRequest: withRetries( retryCount )( actionOrInbound.originalRequest ) } )
		: merge( actionOrInbound, { meta: { dataLayer: { retryCount } } } );

describe( '#retryOnFailure', () => {
	let clock;
	let dispatch;
	let store;

	useFakeTimers( fakeClock => clock = fakeClock );

	beforeEach( () => {
		dispatch = spy();
		store = { dispatch };
	} );

	it( 'should pass through initially successful requests', () => {
		const inbound = { nextData: 1, originalRequest: getSites, store };

		expect( retryOnFailure( inbound ) ).to.equal( inbound );

		clock.tick( 20000 );
		expect( dispatch ).to.have.not.been.called;
	} );

	it( 'should pass through no-retry failed requests', () => {
		const originalRequest = { ...getSites, options: { whenFailing: noRetry() } };
		const inbound = { nextError, originalRequest, store };

		expect( retryOnFailure( inbound ) ).to.equal( inbound );

		clock.tick( 20000 );
		expect( dispatch ).to.have.not.been.called;
	} );

	it( 'should pass through POST requests', () => {
		const originalRequest = { ...getSites, method: 'POST', options: { whenFailing: simpleRetry( { delay: 1000 } ) } };
		const inbound = { nextError, originalRequest, store };

		expect( retryOnFailure( inbound ) ).to.equal( inbound );

		clock.tick( 20000 );
		expect( dispatch ).to.have.not.been.called;
	} );

	it( 'should requeue a plain failed request', () => {
		const inbound = { nextError, originalRequest: getSites, store };

		expect( retryWithDelay( 1337 )( inbound ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.not.been.called;

		clock.tick( 1337 );
		expect( dispatch ).to.have.been.calledWith( withRetries( 1 )( getSites ) );
	} );

	it( 'should requeue only up to `maxAttempts`', () => {
		const originalRequest = { ...getSites, options: { whenFailing: simpleRetry( { delay: 1000, maxAttempts: 3 } ) } };
		const inbound = { nextError, originalRequest, store };
		const retryIt = retryWithDelay( 1337 );

		expect( retryIt( inbound ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.not.been.called;

		// retry 1
		clock.tick( 1337 );
		expect( dispatch ).to.have.been.calledWith( withRetries( 1 )( originalRequest ) );

		// retry 2
		expect( retryIt( {
			...inbound,
			originalRequest: dispatch.lastCall.args[ 0 ],
		} ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch.callCount ).to.equal( 1 );

		clock.tick( 1337 );
		expect( dispatch.callCount ).to.equal( 2 );
		expect( dispatch ).to.have.been.calledWith( withRetries( 2 )( originalRequest ) );

		// retry 3
		expect( retryIt( {
			...inbound,
			originalRequest: dispatch.lastCall.args[ 0 ],
		} ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch.callCount ).to.equal( 2 );

		clock.tick( 1337 );
		expect( dispatch.callCount ).to.equal( 3 );
		expect( dispatch ).to.have.been.calledWith( withRetries( 3 )( originalRequest ) );

		// retry 4
		const finalRequest = { ...inbound, originalRequest: dispatch.lastCall.args[ 0 ] };
		expect( retryIt( finalRequest ) ).to.equal( finalRequest );
		expect( dispatch.callCount ).to.equal( 3 );

		clock.tick( 1337 );
		expect( dispatch.callCount ).to.equal( 3 );
	} );

	it( 'should handle `simpleDelay`', () => {
		const originalRequest = { ...getSites, options: { whenFailing: simpleRetry( { delay: 1000, maxAttempts: 3 } ) } };
		const inbound = { nextError, originalRequest, store };

		// retry 1
		expect( retryOnFailure( inbound ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.not.been.called;

		clock.tick( 2 * 1000 );
		expect( dispatch ).to.have.been.calledOnce;

		clock.tick( 20000 );
		expect( dispatch ).to.have.been.calledOnce;

		// retry 2 (should have same delay range)
		expect( retryOnFailure( withRetries( 2 )( inbound ) ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.been.calledOnce;

		clock.tick( 2 * 1000 );
		expect( dispatch ).to.have.been.calledTwice;

		clock.tick( 20000 );
		expect( dispatch ).to.have.been.calledTwice;

		// retry 3 (should not retry)
		expect( retryOnFailure( withRetries( 3 )( inbound ) ) ).to.eql( withRetries( 3 )( inbound ) );
		expect( dispatch ).to.have.been.calledTwice;

		clock.tick( 20000 );
		expect( dispatch ).to.have.been.calledTwice;
	} );

	it( 'should handle `exponentialBackoff`', () => {
		const originalRequest = { ...getSites, options: { whenFailing: exponentialBackoff( { delay: 1000, maxAttempts: 5 } ) } };
		const inbound = { nextError, originalRequest, store };

		// retry 1
		expect( retryOnFailure( inbound ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.not.been.called;

		clock.tick( 1000 + 3 * 1000 );
		expect( dispatch ).to.have.been.calledOnce;

		clock.tick( 200000 );
		expect( dispatch ).to.have.been.calledOnce;

		// retry 4 (should have much longer delay)
		expect( retryOnFailure( withRetries( 4 )( inbound ) ) ).to.have.property( 'shouldAbort', true );
		expect( dispatch ).to.have.been.calledOnce;

		clock.tick( 1000 + 3 * 16000 );
		expect( dispatch ).to.have.been.calledTwice;

		clock.tick( 200000 );
		expect( dispatch ).to.have.been.calledTwice;

		// retry 5 (should not retry)
		expect( retryOnFailure( withRetries( 5 )( inbound ) ) ).to.eql( withRetries( 5 )( inbound ) );
		expect( dispatch ).to.have.been.calledTwice;

		clock.tick( 200000 );
		expect( dispatch ).to.have.been.calledTwice;
	} );
} );
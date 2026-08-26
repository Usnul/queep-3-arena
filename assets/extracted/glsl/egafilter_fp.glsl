uniform sampler2D u_Texture0; 
varying vec2 texture_coordinate;

void main()
{
	
    // Sampling The Texture And Passing It To The Frame Buffer 
    gl_FragColor = texture2D(u_Texture0, texture_coordinate); 

// LEILEI EGA POSTPOOCESS BAGIN
// 16 color ega works with highlight colors and normal colors, and to prevent /mixing/ of them we divide them first
// there's either a mix of 0 and 170, or 85 and 255,
// NEVER 255 and 170, or 0 and 85 (that's Web Safe territory)
// this is my first glsl shader ever
	float egar;
	float egag;
	float egab;
	float egaa; // average, not alpha
	float egahighlightthreshold = 0.6;
	float egadarkhold = 0.1;

	gl_FragColor = gl_FragColor * 1.4; // more color vibrance necessary


	egar = gl_FragColor.r;
	egag = gl_FragColor.g;
	egab = gl_FragColor.b;
	egaa = egar + egag + egab / 3;

if (egaa > egahighlightthreshold)
		{	// it's a highlight
		if (egar > egahighlightthreshold) 	egar = 1;
		else egar = 0.33;
		if (egag > egahighlightthreshold) 	egag = 1;
		else egag = 0.33;
		if (egab > egahighlightthreshold) 	egab = 1;
		else egab = 0.33;
		if ((egar == 0.33) && (egag == 0.33) && (egab == 0.33)){
			egar = 1; egag = 1; egab = 1; } // swap dark gray for gray for stupid fix
		}
	else
		{
		// it's not a highlight

		if (egar > egadarkhold) 	egar = 0.667;
		else egar = 0;
		if (egag > egadarkhold) 	egag = 0.667;
		else egag = 0;
		if (egab > egadarkhold - 0.02) 	egab = 0.667;
		else egab = 0;

		if ((egar == 0.667) && (egag == 0.667) && (egab == 0)){
			egag = 0.33;}   // ega is wierd when dealing with brown 
					// it's the only color that uses 0 and 85
					// (otherwise we get 'ski free dog pee' brown)
		}

		gl_FragColor.r = egar;	// frag out!
		gl_FragColor.g = egag;
		gl_FragColor.b = egab;


	gl_FragColor = gl_FragColor * 0.5;
// LEILEI EGA POSTPOOCESS END

}	